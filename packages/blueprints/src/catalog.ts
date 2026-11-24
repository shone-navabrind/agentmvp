import type { Blueprint } from "./schema.ts";
import { assertBlueprint } from "./validate.ts";

/**
 * Curated blueprints. Each one is validated at module load, so a typo here fails the
 * test suite rather than a customer's first project.
 */

const odoo: unknown = {
  id: "odoo-18-enterprise",
  version: "1.0.0",
  name: "Odoo 18 + Enterprise addons",
  summary: "Odoo 18 in Docker with your enterprise addons mounted and a development database restored.",
  origin: "catalog",
  tags: ["erp", "python", "postgres", "docker"],
  sandbox: { vcpu: 4, memMiB: 8192, diskGiB: 40, needsDocker: true, minIsolation: "vm" },

  services: [
    {
      name: "db",
      image: "postgres:16",
      dataKind: "postgres",
      env: {
        POSTGRES_DB: "postgres",
        POSTGRES_USER: "odoo",
        POSTGRES_PASSWORD: "${input.DB_PASSWORD}",
      },
      volumes: ["odoo-db:/var/lib/postgresql/data"],
      healthcheck: { test: "pg_isready -U odoo", intervalSec: 5, timeoutSec: 3, retries: 30 },
    },
    {
      name: "odoo",
      image: "odoo:18",
      dependsOn: ["db"],
      // Holds the filestore volume, so a files seed may legitimately target it.
      dataKind: "files",
      env: {
        HOST: "db",
        USER: "odoo",
        PASSWORD: "${input.DB_PASSWORD}",
      },
      ports: [
        { container: 8069, primary: true, label: "Odoo web" },
        { container: 8072, primary: false, label: "longpolling" },
      ],
      volumes: [
        "/workspace/addons:/mnt/extra-addons",
        "/workspace/enterprise:/mnt/enterprise",
        "odoo-filestore:/var/lib/odoo",
        "/workspace/.harness/odoo.conf:/etc/odoo/odoo.conf",
      ],
      healthcheck: {
        test: "curl -fsS http://localhost:8069/web/health || exit 1",
        intervalSec: 10,
        timeoutSec: 5,
        retries: 30,
      },
    },
  ],

  repos: [
    {
      id: "addons",
      label: "Your custom addons",
      mountPath: "/workspace/addons",
      required: true,
      multiple: true,
      hint: "The repository holding your own Odoo modules.",
    },
    {
      id: "enterprise",
      label: "Enterprise addons",
      mountPath: "/workspace/enterprise",
      required: false,
      hint: "Your licensed Odoo Enterprise repository, if you have one.",
    },
  ],

  seeds: [
    {
      id: "devdb",
      label: "Development database",
      kind: "postgres",
      service: "db",
      accepts: [".sql", ".dump", ".gz"],
      required: false,
      maxMiB: 4096,
      neutralize: {
        enabled: true,
        // Odoo dumps carry live partner data, mail servers and cron jobs that will
        // happily email real customers the moment the instance boots.
        recipes: ["odoo-scrub-partners", "odoo-disable-mail", "odoo-disable-cron"],
      },
      hint: "A copy of your Odoo database. We remove contact details and switch off outgoing mail and scheduled jobs before the assistant touches it.",
    },
    {
      id: "filestore",
      label: "Attachments",
      kind: "files",
      service: "odoo",
      accepts: [".tar.gz", ".zip"],
      required: false,
      hint: "Your Odoo filestore, if you want attachments and images present.",
    },
  ],

  inputs: [
    {
      key: "DB_PASSWORD",
      label: "Database password",
      required: true,
      secret: true,
      default: "odoo-dev",
      hint: "Only used inside your private machine.",
    },
    {
      key: "ODOO_DB_NAME",
      label: "Database name",
      required: true,
      secret: false,
      default: "odoo",
      hint: "The database the site runs on.",
    },
  ],

  setup: [
    {
      id: "write-conf",
      label: "Write odoo.conf",
      run: "host",
      idempotent: true,
      script: [
        "mkdir -p /workspace/.harness /workspace/addons /workspace/enterprise",
        "cat > /workspace/.harness/odoo.conf <<'CONF'",
        "[options]",
        "addons_path = /mnt/extra-addons,/mnt/enterprise",
        "db_host = db",
        "db_user = odoo",
        "db_password = ${input.DB_PASSWORD}",
        "dbfilter = ^${input.ODOO_DB_NAME}$",
        "workers = 2",
        "limit_time_real = 600",
        "CONF",
      ].join("\n"),
    },
    {
      id: "module-list",
      label: "Index installed modules",
      run: "service",
      service: "odoo",
      idempotent: true,
      timeoutSec: 600,
      script: "odoo --stop-after-init -d ${input.ODOO_DB_NAME} -u base --no-http || true",
    },
  ],

  verify: [
    { id: "db-up", label: "Database accepting connections", kind: "shell", target: "docker compose exec -T db pg_isready -U odoo", timeoutSec: 60 },
    { id: "web-up", label: "Odoo answering on 8069", kind: "http", target: "http://localhost:8069/web/health", expect: "200", timeoutSec: 180 },
    { id: "addons-mounted", label: "Custom addons visible to Odoo", kind: "shell", target: "docker compose exec -T odoo ls /mnt/extra-addons", timeoutSec: 30 },
  ],

  bundles: {
    skills: ["odoopim-development", "python-patterns", "postgres-patterns", "docker-patterns"],
    mcp: [],
    instructions: [
      "This project runs Odoo 18 in Docker.",
      "- Custom modules live in /workspace/addons and are mounted at /mnt/extra-addons.",
      "- Enterprise addons, when attached, are at /mnt/enterprise.",
      "- Restart Odoo with `docker compose restart odoo`; it does not hot-reload Python.",
      "- Upgrade a module with `docker compose exec odoo odoo -d $ODOO_DB_NAME -u <module> --stop-after-init`.",
      "- The database is a scrubbed copy. Outgoing mail and scheduled jobs are disabled; do not re-enable them.",
    ].join("\n"),
  },

  ui: {
    estimateMinutes: 8,
    whatYouGet: [
      "Odoo 18 running on its own private machine, with your modules already loaded",
      "A copy of your database with customer contact details removed",
      "Email sending and scheduled jobs switched off, so nothing reaches real customers",
      "An assistant that already knows how your Odoo project is laid out",
    ],
    friendlySteps: {
      "write-conf": "Configuring Odoo",
      "module-list": "Loading your modules",
    },
  },
};

const wordpress: unknown = {
  id: "wordpress-6-php83",
  version: "1.0.0",
  name: "WordPress 6 + MySQL",
  summary: "WordPress with your theme or plugin repository mounted and a database dump restored.",
  origin: "catalog",
  tags: ["cms", "php", "mysql", "docker"],
  sandbox: { vcpu: 2, memMiB: 4096, diskGiB: 20, needsDocker: true, minIsolation: "vm" },

  services: [
    {
      name: "db",
      image: "mysql:8.4",
      dataKind: "mysql",
      env: {
        MYSQL_DATABASE: "wordpress",
        MYSQL_USER: "wordpress",
        MYSQL_PASSWORD: "${input.DB_PASSWORD}",
        MYSQL_ROOT_PASSWORD: "${input.DB_PASSWORD}",
      },
      volumes: ["wp-db:/var/lib/mysql"],
      healthcheck: { test: "mysqladmin ping -h 127.0.0.1 --silent", intervalSec: 5, timeoutSec: 3, retries: 40 },
    },
    {
      name: "wordpress",
      image: "wordpress:6-php8.3-apache",
      dependsOn: ["db"],
      env: {
        WORDPRESS_DB_HOST: "db",
        WORDPRESS_DB_USER: "wordpress",
        WORDPRESS_DB_PASSWORD: "${input.DB_PASSWORD}",
        WORDPRESS_DB_NAME: "wordpress",
        WORDPRESS_DEBUG: "1",
      },
      ports: [{ container: 80, primary: true, label: "WordPress" }],
      volumes: ["wp-content:/var/www/html/wp-content", "/workspace/site:/var/www/html/wp-content/themes/custom"],
      healthcheck: { test: "curl -fsS http://localhost/ >/dev/null || exit 1", intervalSec: 10, timeoutSec: 5, retries: 30 },
    },
  ],

  repos: [
    {
      id: "site",
      label: "Your theme or plugin",
      mountPath: "/workspace/site",
      required: true,
      hint: "The repository with the theme or plugin you are working on.",
    },
  ],

  seeds: [
    {
      id: "wpdb",
      label: "Site database",
      kind: "mysql",
      service: "db",
      accepts: [".sql", ".sql.gz", ".zip"],
      required: false,
      maxMiB: 2048,
      neutralize: {
        enabled: true,
        recipes: ["wp-scrub-users", "wp-rewrite-siteurl", "wp-disable-mail"],
      },
      hint: "An export of your live site. We replace real email addresses, point the address at your private copy, and stop it sending mail.",
    },
  ],

  inputs: [
    { key: "DB_PASSWORD", label: "Database password", required: true, secret: true, default: "wp-dev", hint: "Only used inside your private machine." },
  ],

  setup: [
    {
      id: "wp-cli",
      label: "Install WP-CLI",
      run: "service",
      service: "wordpress",
      idempotent: true,
      script:
        "command -v wp >/dev/null || (curl -fsSLo /usr/local/bin/wp https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar && chmod +x /usr/local/bin/wp)",
    },
  ],

  verify: [
    { id: "db-up", label: "Database accepting connections", kind: "shell", target: "docker compose exec -T db mysqladmin ping -h 127.0.0.1 --silent", timeoutSec: 90 },
    { id: "http-200", label: "Site responding", kind: "http", target: "http://localhost/", expect: "200", timeoutSec: 120 },
  ],

  bundles: {
    skills: ["laravel-plugin-discovery", "php-patterns", "mysql-patterns"],
    mcp: [],
    instructions: [
      "This project runs WordPress 6 on PHP 8.3 in Docker.",
      "- Your theme is mounted at /var/www/html/wp-content/themes/custom.",
      "- WP-CLI is available inside the wordpress container.",
      "- The database is a scrubbed copy; user emails are rewritten and mail is disabled.",
    ].join("\n"),
  },

  ui: {
    estimateMinutes: 5,
    whatYouGet: [
      "WordPress running on its own private machine with your theme already active",
      "A copy of your site's content, with real user emails replaced",
      "Email sending switched off, so nothing reaches your visitors",
      "A live preview you can click through while the assistant works",
    ],
    friendlySteps: { "wp-cli": "Installing site tools" },
  },
};

const nodePg: unknown = {
  id: "node-22-postgres",
  version: "1.0.0",
  name: "Node 22 + Postgres",
  summary: "A blank modern web stack: Node 22, Postgres 16, no framework assumed.",
  origin: "catalog",
  tags: ["node", "typescript", "postgres", "greenfield"],
  sandbox: { vcpu: 2, memMiB: 4096, diskGiB: 20, needsDocker: true, minIsolation: "vm" },
  services: [
    {
      name: "db",
      image: "postgres:16",
      dataKind: "postgres",
      env: { POSTGRES_DB: "app", POSTGRES_USER: "app", POSTGRES_PASSWORD: "${input.DB_PASSWORD}" },
      volumes: ["pg:/var/lib/postgresql/data"],
      healthcheck: { test: "pg_isready -U app", intervalSec: 5, timeoutSec: 3, retries: 30 },
    },
    {
      name: "app",
      image: "node:22",
      dependsOn: ["db"],
      command: "sh -c 'cd /workspace/app && (npm ci || npm install) && npm run dev'",
      env: { DATABASE_URL: "postgres://app:${input.DB_PASSWORD}@db:5432/app", NODE_ENV: "development" },
      ports: [{ container: 3000, primary: true, label: "App" }],
      volumes: ["/workspace/app:/workspace/app"],
    },
  ],
  repos: [{ id: "app", label: "Your application", mountPath: "/workspace/app", required: true, hint: "Leave empty to start a new project from scratch." }],
  seeds: [
    {
      id: "pgdump",
      label: "Existing database",
      kind: "postgres",
      service: "db",
      required: false,
      accepts: [".sql", ".dump"],
      neutralize: { enabled: true, recipes: ["generic-scrub-emails"] },
      hint: "Optional. An existing copy of your data to start from.",
    },
  ],
  inputs: [{ key: "DB_PASSWORD", label: "Database password", required: true, secret: true, default: "app-dev", hint: "Only used inside your private machine." }],
  setup: [],
  verify: [
    { id: "db-up", label: "Database accepting connections", kind: "shell", target: "docker compose exec -T db pg_isready -U app", timeoutSec: 60 },
    { id: "app-up", label: "App responding", kind: "http", target: "http://localhost:3000/", timeoutSec: 180 },
  ],
  bundles: {
    skills: ["typescript-patterns", "postgres-patterns", "api-design", "test-driven-development"],
    mcp: [],
    instructions: "Node 22 and Postgres 16 in Docker. The app is mounted at /workspace/app and started with `npm run dev`.",
  },
  ui: {
    estimateMinutes: 4,
    whatYouGet: [
      "A private machine with Node 22 and a Postgres database",
      "A live preview that updates as the assistant works",
      "Nothing opinionated: the assistant builds whatever you describe",
    ],
    friendlySteps: {},
  },
};

export const CATALOG: Blueprint[] = [odoo, wordpress, nodePg].map(assertBlueprint);

export function findBlueprint(id: string): Blueprint | undefined {
  return CATALOG.find((b) => b.id === id);
}

export function searchCatalog(query: string): Blueprint[] {
  const q = query.toLowerCase().trim();
  if (!q) return CATALOG;
  return CATALOG.filter((b) =>
    [b.id, b.name, b.summary, ...b.tags].some((f) => f.toLowerCase().includes(q)),
  );
}
