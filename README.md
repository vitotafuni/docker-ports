# Docker Ports Manager (docker-ports)

A centralized cross-project port assignment registry CLI tailored for agency servers and development machines where multiple containers contend for public port bindings. Use this utility as a robust, structured scratchpad ledger to lock base port clusters without running heavy reverse proxies.

## Features
- **Zero Host Overhead**: Pure, lightweight Node.js architecture.
- **Dynamic Port Jumps**: Safe sequential assignment using configurable offset ranges.
- **Flexible Scope Control**: Share ledgers across users via directory mapping configurations or file path overrides.
- **Manual Adjustments Supported**: Merge explicit legacy configurations into standard tracking logs instantly.

## Installation

Install globally straight from Git repository resource endpoint:
```bash
npm install -g git+https://github.com/vitotafuni/docker-ports.git
```

## Usage Cheatsheet

### 1. Tracking Configurations
```bash
# Add project automatically calculating next sequence block
docker-ports add storefront-api

# Add project mapping a descriptive string
docker-ports add portal-fe "Client portal react application entry"

# Bind an explicit port assignment forcefully
docker-ports add legacy-db 3307 "Shared fallback postgres mapping node"
```

### 2. Monitoring & Audits
```bash
# Display tabular register matrix records sorted by active ports
docker-ports list

# Query next unassigned baseline index for orchestration automation tasks
docker-ports next
```

### 3. Updates & Deletions
```bash
# Force-modify assigned ports or definitions on a project profile
docker-ports update storefront-api 8020 "Migrated container ingress rule"

# Remove project metadata from database tracking registries
docker-ports del storefront-api
```

### 4. Shared Registry Path Context Remapping
```bash
# Redirect active folder queries to read/write onto a shared filesystem partition
docker-ports path /mnt/shared/agency-port-ledger

# Inquire where data maps currently resolve
docker-ports path

# Remove local configuration context mapping blocks
docker-ports path --reset
```

### 5. Adjust Intervals and Starting Baselines
```bash
# Reconfigure calculation bounds to assign from 5000 onwards incrementing by 20 entries
docker-ports start 5000 20
```
