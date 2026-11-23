import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostPool, OutOfCapacity } from "./host-pool.ts";
import { LocalProcessDriver } from "./drivers/local.ts";
import { IncusDriver, incusArgv, type Exec } from "./drivers/incus.ts";
import { Scheduler } from "./scheduler.ts";
import {
  filterCapable,
  NoCapableDriver,
  type ComputeCapabilities,
  type ComputeDriver,
  type SandboxSpec,
} from "./driver.ts";

const SIZE = { vcpu: 2, memMiB: 2048, diskGiB: 10 };
const spec = (over: Partial<SandboxSpec> = {}): SandboxSpec => ({
  projectId: "p1",
  imageVersion: "1.0.0",
  size: SIZE,
  enrollmentToken: "tok-abc",
  ...over,
});

function fakeDriver(id: string, caps: Partial<ComputeCapabilities>, cost = 0): ComputeDriver {
  const capabilities: ComputeCapabilities = {
    isolation: "vm",
    snapshot: true,
    restore: true,
    resize: true,
    pause: true,
    nested: true,
    gpu: false,
    bootP50Ms: 1000,
    maxSessions: 8,
    ...caps,
  };
  let n = 0;
  return {
    id,
    capabilities: () => capabilities,
    async plan() {
      return { driver: id, hostId: `${id}-host`, costMicrosPerHour: cost };
    },
    async create() {
      return { driver: id, id: `${id}-sbx-${n++}`, hostId: `${id}-host` };
    },
    async start() {},
    async stop() {},
    async destroy() {},
    async state() {
      return "running" as const;
    },
    async metrics() {
      return { cpuPct: 0, memMiB: 0, diskGiB: 0 };
    },
  };
}

describe("host pool: splitting a host's own spec", () => {
  const pool = () =>
    new HostPool().addHost({
      id: "h1",
      total: { vcpu: 16, memMiB: 32768, diskGiB: 500 },
      reserved: { vcpu: 2, memMiB: 4096, diskGiB: 50 },
      overcommit: { vcpu: 2, memMiB: 1, diskGiB: 1 },
    });

  test("allocatable = (total - reserved) x overcommit", () => {
    assert.deepEqual(pool().allocatable("h1"), { vcpu: 28, memMiB: 28672, diskGiB: 450 });
  });

  test("memory is never overcommitted even when CPU is", () => {
    const p = pool();
    // 14 sandboxes x 2 GiB = 28 GiB, exactly the allocatable memory.
    for (let i = 0; i < 14; i++) p.allocate("h1", `s${i}`, SIZE);
    assert.equal(p.free("h1").memMiB, 0);
    assert.equal(p.fits("h1", SIZE), false);
    assert.throws(() => p.allocate("h1", "s99", SIZE), OutOfCapacity);
  });

  test("refuses placement instead of thrashing, and says what is free", () => {
    const p = pool();
    for (let i = 0; i < 14; i++) p.allocate("h1", `s${i}`, SIZE);
    try {
      p.allocate("h1", "overflow", SIZE);
      assert.fail("should refuse");
    } catch (err) {
      assert.ok(err instanceof OutOfCapacity);
      assert.equal(err.retryable, false);
      assert.deepEqual((err.details.free as { memMiB: number }).memMiB, 0);
    }
  });

  test("releasing frees capacity for the next project", () => {
    const p = pool();
    for (let i = 0; i < 14; i++) p.allocate("h1", `s${i}`, SIZE);
    p.release("h1", "s0");
    assert.equal(p.fits("h1", SIZE), true);
  });

  test("best-fit packs onto the tightest host that still fits", () => {
    const p = new HostPool()
      .addHost({
        id: "big",
        total: { vcpu: 32, memMiB: 65536, diskGiB: 1000 },
        reserved: { vcpu: 0, memMiB: 0, diskGiB: 0 },
        overcommit: { vcpu: 1, memMiB: 1, diskGiB: 1 },
      })
      .addHost({
        id: "small",
        total: { vcpu: 4, memMiB: 4096, diskGiB: 100 },
        reserved: { vcpu: 0, memMiB: 0, diskGiB: 0 },
        overcommit: { vcpu: 1, memMiB: 1, diskGiB: 1 },
      });
    assert.equal(p.pick(SIZE), "small", "leave the big host free for big workloads");
  });
});

describe("capability negotiation", () => {
  const vm = fakeDriver("incus", { isolation: "vm", snapshot: true, nested: true });
  const oci = fakeDriver("oci", { isolation: "container", snapshot: false, nested: false });

  test("a container driver is excluded when VM isolation is required", () => {
    const r = filterCapable([vm, oci], { minIsolation: "vm" });
    assert.deepEqual(r.capable.map((d) => d.id), ["incus"]);
    assert.match(r.rejected.oci, /isolation "container" is weaker than required "vm"/);
  });

  test("a driver without snapshots is excluded, with a reason the UI can show", () => {
    const r = filterCapable([vm, oci], { snapshot: true });
    assert.equal(r.rejected.oci, "does not support snapshots");
  });

  test("nothing capable is a hard, non-retryable error naming every rejection", async () => {
    const s = new Scheduler({ drivers: [oci] });
    try {
      await s.acquire(spec({ requires: { minIsolation: "vm", gpu: true } }));
      assert.fail("should refuse");
    } catch (err) {
      assert.ok(err instanceof NoCapableDriver);
      assert.equal(err.retryable, false);
      assert.ok((err.details.reasons as Record<string, string>).oci);
    }
  });

  test("a weaker driver is used when policy permits it", () => {
    const r = filterCapable([oci], { minIsolation: "container" });
    assert.equal(r.capable.length, 1);
  });
});

describe("scheduler", () => {
  test("ranks by cost, then by boot time", async () => {
    const cheapSlow = fakeDriver("cheap", { bootP50Ms: 20_000 }, 100);
    const dearFast = fakeDriver("dear", { bootP50Ms: 500 }, 900);
    const s = new Scheduler({ drivers: [dearFast, cheapSlow] });
    const d = await s.acquire(spec());
    assert.equal(d.driver, "cheap");

    const tie = new Scheduler({
      drivers: [fakeDriver("slow", { bootP50Ms: 20_000 }, 100), fakeDriver("fast", { bootP50Ms: 500 }, 100)],
    });
    assert.equal((await tie.acquire(spec())).driver, "fast");
  });

  test("a warm sandbox turns create-project into an assignment", async () => {
    const d = fakeDriver("incus", {});
    const s = new Scheduler({ drivers: [d], targetWarm: 2 });

    assert.equal(await s.refillWarmPool({ imageVersion: "1.0.0", size: SIZE, enrollmentToken: "t" }), 2);
    assert.equal(s.warmCount("1.0.0"), 2);

    const first = await s.acquire(spec());
    assert.equal(first.fromWarmPool, true);
    assert.equal(s.warmCount("1.0.0"), 1);

    const second = await s.acquire(spec());
    assert.equal(second.fromWarmPool, true);
    assert.equal(s.warmCount("1.0.0"), 0);

    const third = await s.acquire(spec());
    assert.equal(third.fromWarmPool, false, "pool exhausted: cold boot");
  });

  test("a warm sandbox of the wrong image version is not handed out", async () => {
    const s = new Scheduler({ drivers: [fakeDriver("incus", {})], targetWarm: 1 });
    await s.refillWarmPool({ imageVersion: "1.0.0", size: SIZE, enrollmentToken: "t" });
    const d = await s.acquire(spec({ imageVersion: "2.0.0" }));
    assert.equal(d.fromWarmPool, false);
    assert.equal(s.warmCount("1.0.0"), 1, "the 1.0.0 sandbox is still pooled");
  });

  test("a warm sandbox that cannot meet the requirements is skipped", async () => {
    const oci = fakeDriver("oci", { isolation: "container", snapshot: false });
    const s = new Scheduler({ drivers: [oci], targetWarm: 1 });
    await s.refillWarmPool({ imageVersion: "1.0.0", size: SIZE, enrollmentToken: "t" });
    await assert.rejects(
      () => s.acquire(spec({ requires: { minIsolation: "vm" } })),
      NoCapableDriver,
    );
  });
});

describe("local-process driver (the one CI can actually run)", () => {
  test("creates, reports, resizes and destroys a sandbox, releasing capacity", async () => {
    const root = await mkdtemp(join(tmpdir(), "hc-local-"));
    const pool = new HostPool().addHost({
      id: "h1",
      total: { vcpu: 8, memMiB: 8192, diskGiB: 100 },
      reserved: { vcpu: 1, memMiB: 1024, diskGiB: 10 },
      overcommit: { vcpu: 1, memMiB: 1, diskGiB: 1 },
    });
    const d = new LocalProcessDriver({ root, pool, hostId: "h1" });

    assert.equal(d.capabilities().isolation, "host", "honest about weak isolation");

    const plan = await d.plan(spec());
    assert.ok(!("unschedulable" in plan));
    const ref = await d.create(spec(), plan);

    assert.equal(await d.state(ref), "running");
    assert.deepEqual(pool.allocationsOn("h1"), [ref.id]);

    await d.stop(ref);
    assert.equal(await d.state(ref), "stopped");
    await d.start(ref);
    assert.equal(await d.state(ref), "running");

    await d.destroy(ref);
    assert.equal(await d.state(ref), "gone");
    assert.deepEqual(pool.allocationsOn("h1"), []);
    await rm(root, { recursive: true, force: true });
  });

  test("reports unschedulable rather than throwing when the host is full", async () => {
    const root = await mkdtemp(join(tmpdir(), "hc-local-"));
    const pool = new HostPool().addHost({
      id: "h1",
      total: { vcpu: 2, memMiB: 2048, diskGiB: 10 },
      reserved: { vcpu: 1, memMiB: 1024, diskGiB: 5 },
      overcommit: { vcpu: 1, memMiB: 1, diskGiB: 1 },
    });
    const d = new LocalProcessDriver({ root, pool, hostId: "h1" });
    const plan = await d.plan(spec());
    assert.ok("unschedulable" in plan);
    assert.match((plan as { reason: string }).reason, /free/);
    await rm(root, { recursive: true, force: true });
  });
});

describe("incus driver (argv only -- no KVM in CI)", () => {
  test("launch builds a VM, not a system container, with limits and cloud-init", () => {
    const argv = incusArgv.launch(spec(), "sbx-p1-xyz", "node-2");
    assert.deepEqual(argv.slice(0, 5), ["incus", "launch", "harness-base/1.0.0", "sbx-p1-xyz", "--vm"]);
    assert.ok(argv.includes("limits.cpu=2"));
    assert.ok(argv.includes("limits.memory=2048MiB"));
    assert.ok(argv.includes("root,size=10GiB"));
    assert.ok(argv.some((a) => a.includes("--target")) && argv.includes("node-2"));
    const cloudInit = argv.find((a) => a.startsWith("cloud-init.user-data="))!;
    assert.match(cloudInit, /\/etc\/harness\/enrollment-token/);
    assert.match(cloudInit, /tok-abc/);
    assert.match(cloudInit, /permissions: '0600'/);
  });

  test("stop forces with a bounded timeout rather than hanging", () => {
    assert.deepEqual(incusArgv.stop("s1"), ["incus", "stop", "s1", "--force", "--timeout", "30"]);
  });

  test("snapshot and restore name the instance and the snapshot", () => {
    assert.deepEqual(incusArgv.snapshot("s1", "pre-upgrade"), [
      "incus", "snapshot", "create", "s1", "pre-upgrade",
    ]);
    assert.deepEqual(incusArgv.restore("s1", "pre-upgrade"), [
      "incus", "snapshot", "restore", "s1", "pre-upgrade",
    ]);
  });

  test("a failed launch releases the capacity it reserved", async () => {
    const pool = new HostPool().addHost({
      id: "h1",
      total: { vcpu: 8, memMiB: 8192, diskGiB: 100 },
      reserved: { vcpu: 0, memMiB: 0, diskGiB: 0 },
      overcommit: { vcpu: 1, memMiB: 1, diskGiB: 1 },
    });
    const exec: Exec = async () => ({ code: 1, stdout: "", stderr: "no space left on device" });
    const d = new IncusDriver({ exec, pool });
    const plan = await d.plan(spec());
    await assert.rejects(() => d.create(spec(), plan as never), /no space left/);
    assert.deepEqual(pool.allocationsOn("h1"), [], "no capacity leaked by the failed launch");
  });

  test("state maps Incus status onto the driver's vocabulary", async () => {
    const pool = new HostPool();
    const exec: Exec = async (argv) => ({
      code: 0,
      stdout: argv.includes("list") ? JSON.stringify([{ name: "s1", status: "Running" }]) : "",
      stderr: "",
    });
    const d = new IncusDriver({ exec, pool });
    assert.equal(await d.state({ driver: "incus", id: "s1" }), "running");
    assert.equal(await d.state({ driver: "incus", id: "missing" }), "gone");
  });
});
