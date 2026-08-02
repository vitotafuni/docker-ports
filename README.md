# Docker Ports Manager (docker-ports)

A shared registry that assigns every Docker project a block of ports, so two projects never contend for the same one.

It is a small CLI over a single JSON file that holds both the port assignments and the range they follow. No daemon, no reverse proxy, nothing listening. Point several developers at the same file — on a shared partition, for instance — and the registry stays consistent: every write takes an exclusive lock and lands atomically.

## Installation

```bash
npm install -g docker-ports
```

## How ports are assigned

Each project reserves a block of `portStep` ports (10 by default) starting at its base port: a project on `8010` holds `8010-8019`. `add` and `update` reject any port that falls inside another project's block, and `next` returns the first free block starting from `startPort` (8000 by default) — including blocks freed by `del`.

## Usage

### Registering projects

```bash
# Assign the first free block automatically
docker-ports add storefront-api

# Add a description
docker-ports add portal-fe "Client portal React application"

# Pin an explicit port
docker-ports add legacy-db 3307 "Shared fallback postgres"

# Register a deliberate overlap (rejected without the flag)
docker-ports add sidecar 3308 "Shares the legacy-db block" --force
```

### Inspecting

```bash
# All projects, sorted by port
docker-ports list

# First free base port, for scripting
docker-ports next
```

### Updating and removing

```bash
docker-ports update storefront-api 8020 "Migrated container ingress"
docker-ports del storefront-api
```

### Choosing which registry file to use

```bash
# Use a registry on a shared partition
docker-ports path /mnt/shared/team-ports.json

# Show which file is in use, and what it contains
docker-ports path

# Go back to the default file
docker-ports path --reset
```

### Adjusting the range

```bash
# Assign from 5000 onwards, in steps of 20
docker-ports start 5000 20
```

## The registry file

Everything lives in **one JSON file**: the settings and the projects they apply to.

```json
{
  "startPort": 8000,
  "portStep": 20,
  "projects": [
    { "port": 8000, "id": "api", "desc": "servizio api" },
    { "port": 8020, "id": "web", "desc": "" }
  ]
}
```

By default it is `~/.docker-ports/projects.json`. Point at another one — anywhere — with `path`:

```bash
docker-ports path /mnt/shared/team-ports.json
```

That is the whole configuration story. Sharing a registry is sharing that file, so there is nothing to keep in sync: the range travels with the projects it describes, and a colleague who points at the file inherits it.

```bash
$ docker-ports path /mnt/shared/team-ports.json
✔ Registry file set to: /mnt/shared/team-ports.json
  This applies to every directory you run docker-ports from.
  Joined an existing registry: 2 project(s), ports from 8000, blocks of 20.
```

The only thing recorded per user is which file to open, in `~/.docker-ports/config.json`. If you would rather have nothing there at all, name the file in your shell profile instead:

```bash
export DOCKER_PORTS_FILE=/mnt/shared/team-ports.json
```

`DOCKER_PORTS_FILE` also works per command, to look at another registry without changing anything:

```bash
DOCKER_PORTS_FILE=/tmp/scratch.json docker-ports list
```

Passing a directory to `path` or `DOCKER_PORTS_FILE` is fine too — it resolves to `projects.json` inside it.

### Upgrading from earlier versions

Registries written before 1.2.0 were a bare JSON array of projects. They are still read, and the first command that writes upgrades the file in place, keeping every entry. Versions before 1.1.0 also read a `.docker-ports-config.json` from the current directory; that file is now ignored, with a warning, because configuration no longer depends on where the command runs. Run `docker-ports path <file>` once, then delete it — `docker-ports path --reset` removes it for you.

## Tests

```bash
npm test
```

## License

MIT
