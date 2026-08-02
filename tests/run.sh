#!/bin/bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="node $ROOT/index.js"

# -P so the expected paths match what path.resolve() reports: on macOS the
# temp dir is reached through a symlink.
WORK="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"

# Isolate the home directory: the user-level config must never be the real one.
export HOME="$WORK/home"
mkdir -p "$HOME"

export DOCKER_PORTS_FILE="$WORK/registry/ports.json"

failures=0

assert_eq() { # <label> <expected> <actual>
  if [ "$2" = "$3" ]; then
    echo "  ok   $1"
  else
    echo "  FAIL $1: expected '$2', got '$3'"
    failures=$((failures + 1))
  fi
}

assert_rejects() { # <label> <command...>
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then
    echo "  FAIL $label: command succeeded but should have been rejected"
    failures=$((failures + 1))
  else
    echo "  ok   $label"
  fi
}

port_of() { # <project id>
  node -p "const p = require('$DOCKER_PORTS_FILE').projects.find(p => p.id === '$1'); p ? p.port : 'missing'"
}

setting_of() { # <key> [file]
  node -p "require('${2:-$DOCKER_PORTS_FILE}').$1"
}

reset_state() {
  rm -rf "$WORK/registry"
  rm -rf "$HOME/.docker-ports"
  rm -f .docker-ports-config.json
  mkdir -p "$HOME"
}

echo "=== Running Docker Ports CLI Integration Tests ==="

echo "Global options..."
reset_state
assert_eq "--version reports the package version" \
  "v$(node -p "require('$ROOT/package.json').version")" "$($CLI --version)"
$CLI --help > /dev/null || { echo "  FAIL --help exited non-zero"; failures=$((failures + 1)); }

echo "Importing the CLI as a module..."
assert_eq "require() does not terminate the host process" \
  "alive" "$(node -e "require('$ROOT/index.js'); console.log('alive')" 2>/dev/null)"

echo "Port allocation..."
reset_state
assert_eq "next on an empty registry returns startPort" "8000" "$($CLI next)"
$CLI add p1 > /dev/null
$CLI add p2 > /dev/null
$CLI add p3 > /dev/null
assert_eq "sequential adds advance by the step" "8020" "$(port_of p3)"
assert_eq "next after three adds" "8030" "$($CLI next)"
$CLI del p2 > /dev/null
assert_eq "next reuses a freed block" "8010" "$($CLI next)"
$CLI add p4 > /dev/null
assert_eq "add lands on the freed block" "8010" "$(port_of p4)"

echo "Collision and range validation..."
reset_state
$CLI add alfa 8010 "primo" > /dev/null
assert_rejects "an identical port is rejected" $CLI add beta 8010 "secondo"
assert_rejects "a port inside the reserved block is rejected" $CLI add beta 8015 "secondo"
assert_rejects "a port above 65535 is rejected" $CLI add assurdo 99999
assert_rejects "a negative port is rejected" $CLI add negativo -5
$CLI add lontano 9000 "nessuna sovrapposizione" > /dev/null
assert_eq "a non-overlapping explicit port is accepted" "9000" "$(port_of lontano)"
$CLI add forced 8012 "sovrapposto di proposito" --force > /dev/null 2>&1
assert_eq "--force allows a deliberate overlap" "8012" "$(port_of forced)"

echo "update is validated like add..."
reset_state
$CLI add alfa 8000 > /dev/null
$CLI add beta 8100 > /dev/null
assert_rejects "update onto another project's block is rejected" $CLI update beta 8005
assert_eq "the rejected update left the port untouched" "8100" "$(port_of beta)"
$CLI update beta 8200 "spostato" > /dev/null
assert_eq "a valid update is applied" "8200" "$(port_of beta)"

echo "Configuration writes merge instead of replacing..."
reset_state
$CLI start 3000 20 > /dev/null
assert_eq "start records startPort in the registry file" "3000" "$(setting_of startPort)"
assert_eq "start records portStep in the registry file" "20" "$(setting_of portStep)"
assert_eq "the configured startPort is honoured" "3000" "$($CLI next)"
$CLI add convivente > /dev/null
$CLI start 4000 > /dev/null
assert_eq "changing the range keeps the projects in the same file" \
  "3000" "$(port_of convivente)"
assert_eq "and it updates the setting" "4000" "$(setting_of startPort)"
assert_eq "settings and projects live in one file" \
  "startPort,portStep,projects" "$(node -p "Object.keys(require('$DOCKER_PORTS_FILE')).join(',')")"

echo "The registry location is a user setting, not a per-directory one..."
reset_state
unset DOCKER_PORTS_FILE
LEDGER="$WORK/shared-ledger/team-ports.json"
$CLI path "$LEDGER" > /dev/null
assert_eq "path records the registry file for the user" \
  "$LEDGER" "$(setting_of registryFile "$HOME/.docker-ports/config.json")"
assert_eq "path does not write into the current directory" \
  "absent" "$([ -e .docker-ports-config.json ] && echo present || echo absent)"
$CLI add ovunque > /dev/null
mkdir -p "$WORK/another-dir"
assert_eq "the same registry is used from a different directory" \
  "8000" "$(cd "$WORK/another-dir" && node -p "require('$LEDGER').projects[0].port")"
assert_eq "next from a different directory agrees" \
  "8010" "$(cd "$WORK/another-dir" && $CLI next)"

echo "Settings travel inside the registry file, so they are shared..."
$CLI start 9000 50 > /dev/null
assert_eq "start writes into the registry file itself" \
  "50" "$(setting_of portStep "$LEDGER")"
assert_eq "nothing but the pointer is stored in the home directory" \
  "registryFile" "$(node -p "Object.keys(require('$HOME/.docker-ports/config.json')).join(',')")"
assert_eq "a second user pointing at the same file inherits the step" \
  "9000" "$(HOME="$WORK/home2" sh -c "mkdir -p \"\$HOME\" && $CLI path '$LEDGER' > /dev/null && $CLI next")"
assert_eq "joining an existing registry reports what it inherited" \
  "1" "$(HOME="$WORK/home3" sh -c "mkdir -p \"\$HOME\" && $CLI path '$LEDGER'" | grep -c 'Joined an existing registry: 1 project(s), ports from 9000, blocks of 50')"
assert_eq "pointing at a brand new registry says so instead" \
  "1" "$(HOME="$WORK/home4" sh -c "mkdir -p \"\$HOME\" && $CLI path '$WORK/brand-new.json'" | grep -c 'New registry')"

echo "path accepts a directory and picks the default file name..."
mkdir -p "$WORK/as-dir"
assert_eq "a directory target resolves to projects.json inside it" \
  "$WORK/as-dir/projects.json" "$(HOME="$WORK/home5" sh -c "mkdir -p \"\$HOME\" && $CLI path '$WORK/as-dir' > /dev/null && $CLI path | head -1 | sed 's/^Registry file: //'")"

echo "path --reset clears the user setting..."
$CLI path --reset > /dev/null
assert_eq "the registry falls back to the default file" \
  "$HOME/.docker-ports/projects.json" "$($CLI path | head -1 | sed 's/^Registry file: //')"

echo "A pre-1.2 registry (bare array) is still readable..."
export DOCKER_PORTS_FILE="$WORK/registry/ports.json"
reset_state
mkdir -p "$WORK/registry"
printf '[{"port":8000,"id":"vecchio","desc":"formato legacy"}]' > "$DOCKER_PORTS_FILE"
assert_eq "legacy entries are visible before any upgrade" \
  "1" "$($CLI list 2>/dev/null | grep -c '8000 .*vecchio')"
assert_eq "next accounts for legacy entries" "8010" "$($CLI next)"
$CLI add nuovo > /dev/null
assert_eq "the first write upgrades the file in place" \
  "startPort,portStep,projects" "$(node -p "Object.keys(require('$DOCKER_PORTS_FILE')).join(',')")"
assert_eq "and the legacy entry survived the upgrade" "8000" "$(port_of vecchio)"

echo "A leftover per-project config is ignored, loudly..."
reset_state
echo '{"storagePath":"/nowhere"}' > .docker-ports-config.json
assert_eq "the obsolete file does not redirect the registry" \
  "absent" "$($CLI path 2>/dev/null | grep -c nowhere | sed 's/^0$/absent/')"
assert_eq "and it is reported on stderr" \
  "1" "$($CLI path 2>&1 >/dev/null | grep -c 'no longer read')"
rm -f .docker-ports-config.json
export DOCKER_PORTS_FILE="$WORK/registry/ports.json"

echo "A corrupted registry is refused, never silently emptied..."
reset_state
$CLI add sopravvissuto > /dev/null
printf '[{"port":8000,"id":"sopravvissuto","desc":""}]]' > "$DOCKER_PORTS_FILE"
assert_rejects "add refuses to run on a corrupted registry" $CLI add nuovo
assert_eq "the corrupted file was left untouched" \
  "1" "$(grep -c 'sopravvissuto' "$DOCKER_PORTS_FILE")"

echo "Concurrent adds do not lose entries (10 rounds)..."
reset_state
for round in $(seq 1 10); do
  rm -rf "$WORK/registry"
  $CLI add seme > /dev/null
  for i in $(seq 1 10); do $CLI add "proj$i" > /dev/null 2>&1 & done
  wait
  summary="$(node -e "
    const d = require('$DOCKER_PORTS_FILE').projects;
    console.log(d.length + ' ' + new Set(d.map(p => p.port)).size);
  " 2>/dev/null)"
  assert_eq "round $round: 11 projects on 11 distinct ports" "11 11" "$summary"
done

echo
if [ "$failures" -eq 0 ]; then
  echo "=== All Tests Passed Successfully ==="
else
  echo "=== $failures assertion(s) FAILED ==="
  exit 1
fi
