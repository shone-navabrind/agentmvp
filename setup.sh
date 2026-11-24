#!/usr/bin/env bash
#
# Harness Cloud — local setup.
#
#   ./setup.sh            pick Docker if it is available, otherwise run on Node
#   ./setup.sh docker     force the container path
#   ./setup.sh local      force the Node path
#   ./setup.sh test       install and run the full suite, start nothing
#   ./setup.sh down       stop and remove the container
#
# Safe to re-run. It changes nothing outside this directory and the Docker objects
# it names.

set -euo pipefail

PORT="${PORT:-8787}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

# Colour only when attached to a terminal, so logs and CI stay clean.
if [ -t 1 ]; then
  B=$'\033[1m'; DIM=$'\033[2m'; GRN=$'\033[32m'; YLW=$'\033[33m'; RED=$'\033[31m'; OFF=$'\033[0m'
else
  B=""; DIM=""; GRN=""; YLW=""; RED=""; OFF=""
fi
say()  { printf '%s\n' "$*"; }
step() { printf '%s==>%s %s\n' "$B" "$OFF" "$*"; }
ok()   { printf '%s  ok%s  %s\n' "$GRN" "$OFF" "$*"; }
warn() { printf '%s  !!%s  %s\n' "$YLW" "$OFF" "$*"; }
die()  { printf '%s error%s %s\n' "$RED" "$OFF" "$*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

docker_usable() {
  have docker || return 1
  docker compose version >/dev/null 2>&1 || return 1
  # The CLI can exist with no daemon behind it; that is the case worth catching early.
  docker info >/dev/null 2>&1 || return 1
  return 0
}

node_usable() {
  have node || return 1
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$major" -ge 22 ] 2>/dev/null
}

wait_for_http() {
  local url="$1" tries="${2:-60}"
  for _ in $(seq 1 "$tries"); do
    if have curl && curl -fsS -o /dev/null "$url" 2>/dev/null; then return 0; fi
    if ! have curl && node -e "fetch('$url').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

ready() {
  say ""
  printf '%s  Harness Cloud is running%s\n' "$GRN$B" "$OFF"
  say ""
  say "    http://localhost:${PORT}"
  say ""
  say "  ${DIM}Guided view    http://localhost:${PORT}/?role=guided${OFF}"
  say "  ${DIM}Operator view  http://localhost:${PORT}/?role=operator${OFF}"
  say ""
}

run_docker() {
  step "Building the image"
  docker compose build
  step "Starting"
  PORT="$PORT" docker compose up -d
  step "Waiting for it to answer"
  if wait_for_http "http://localhost:${PORT}/api/v1/project" 90; then
    ok "healthy"
    ready
    say "  ${DIM}logs   docker compose logs -f${OFF}"
    say "  ${DIM}stop   ./setup.sh down${OFF}"
  else
    warn "it did not answer in 90s. Recent logs:"
    docker compose logs --tail 40
    die "startup failed"
  fi
}

run_local() {
  step "Installing dependencies"
  npm ci
  step "Starting on Node"
  ready
  say "  ${DIM}Ctrl-C to stop${OFF}"
  say ""
  PORT="$PORT" exec npm start
}

run_tests() {
  step "Installing dependencies"
  npm ci
  step "Running the suite"
  # Browser-backed suites (accessibility, user journey) skip themselves when no
  # Playwright is present rather than failing, so this works on a bare machine.
  npm test
  ok "suite finished"
}

main() {
  local mode="${1:-auto}"

  case "$mode" in
    down)
      docker_usable || die "Docker is not running, so there is nothing to stop."
      step "Stopping"
      docker compose down
      ok "stopped"
      return 0
      ;;
    test)
      node_usable || die "Node 22+ is required to run the tests. Found: $(node -v 2>/dev/null || echo 'no node')."
      run_tests
      return 0
      ;;
  esac

  say ""
  printf '%s  Harness Cloud%s %s— local setup%s\n' "$B" "$OFF" "$DIM" "$OFF"
  say ""

  step "Checking what is available"
  if docker_usable; then ok "Docker with a running daemon"; else warn "no usable Docker daemon"; fi
  if node_usable; then ok "Node $(node -v)"; else warn "no Node 22+"; fi
  say ""

  case "$mode" in
    docker)
      docker_usable || die "Docker is not usable. Is the daemon running? Try: ./setup.sh local"
      run_docker
      ;;
    local)
      node_usable || die "Node 22 or newer is required. Found: $(node -v 2>/dev/null || echo 'no node')."
      run_local
      ;;
    auto)
      if docker_usable; then
        run_docker
      elif node_usable; then
        say "  ${DIM}No Docker daemon, falling back to Node.${OFF}"
        say ""
        run_local
      else
        die "Needs either Docker with a running daemon, or Node 22+. Neither was found."
      fi
      ;;
    *)
      die "Unknown mode '$mode'. Use: docker | local | test | down"
      ;;
  esac
}

main "$@"
