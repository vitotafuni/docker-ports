#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const pc = require('picocolors');

// Loading this file as a module must stay side-effect free: the CLI below calls
// process.exit(), which would otherwise terminate the importing process.
if (require.main !== module) {
  return;
}

// Load metadata dynamically
const pkgPath = path.join(__dirname, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

const rawArgs = process.argv.slice(2);
const force = rawArgs.includes('--force');
const args = rawArgs.filter(a => a !== '--force');
const command = args[0];

const MAX_PORT = 65535;
const DEFAULT_START_PORT = 8000;
const DEFAULT_PORT_STEP = 10;
const DEFAULT_REGISTRY_NAME = 'projects.json';

function fail(message) {
  console.error(pc.red(`Error: ${message}`));
  process.exit(1);
}

function warn(message) {
  console.error(pc.yellow(`Warning: ${message}`));
}

function showHelp() {
  console.log(pc.bold(`\nDocker Project Port Manager (v${pkg.version})`));
  console.log('\nUsage:');
  console.log('  docker-ports <command> [arguments]');
  console.log('\nCommands:');
  console.log(`  list                      ${pc.dim('- Show all registered base ports')}`);
  console.log(`  next                      ${pc.dim('- Get the first free base port number')}`);
  console.log(`  add <id> [port] [desc]    ${pc.dim('- Add a project (auto-calculates port if omitted)')}`);
  console.log(`  update <id> <port> [desc] ${pc.dim('- Update an existing project port and description')}`);
  console.log(`  del <id>                  ${pc.dim('- Remove a project from the registry')}`);
  console.log(`  path [file]               ${pc.dim('- View or set which registry file to use')}`);
  console.log(`  path --reset              ${pc.dim('- Go back to the default registry file')}`);
  console.log(`  start <port> [step]       ${pc.dim('- Set the range and step stored in the registry')}`);
  console.log('\nOptions:');
  console.log(`  --force                   ${pc.dim('- Allow a port that overlaps a reserved block')}`);
  console.log(`  -v, --version             ${pc.dim('- Print the current version of docker-ports')}`);
  console.log(`  -h, --help                ${pc.dim('- Print this help documentation menu\n')}`);
}

// Global Flags Handler
if (command === '--version' || command === '-v') {
  console.log(`v${pkg.version}`);
  process.exit(0);
}

if (command === '--help' || command === '-h' || !command) {
  showHelp();
  process.exit(0);
}

// The registry is a single JSON file holding both the settings and the
// projects they apply to:
//
//   { "startPort": 8000, "portStep": 10, "projects": [ ... ] }
//
// Everything that describes the registry travels with it, so sharing it is
// copying or pointing at one file, and nobody has to keep settings in sync.
// The only thing kept per user is which file to open.
const USER_CONFIG_NAME = 'config.json';
const LEGACY_LOCAL_CONFIG = '.docker-ports-config.json';

function homeDir() {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  if (!home) {
    fail(
      'Cannot determine the home directory (HOME and USERPROFILE are both unset).\n' +
      '       Set DOCKER_PORTS_FILE to choose the registry file explicitly.'
    );
  }
  return home;
}

function userConfigDir() {
  return path.join(homeDir(), '.docker-ports');
}

function userConfigFile() {
  return path.join(userConfigDir(), USER_CONFIG_NAME);
}

function defaultRegistryFile() {
  return path.join(userConfigDir(), DEFAULT_REGISTRY_NAME);
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    warn(`Ignoring unreadable file ${file}: ${e.message}`);
    return {};
  }
}

// A directory is accepted where a file is expected: pointing at a folder that
// already holds a registry is an easy thing to type, and guessing right beats
// an error message.
function asRegistryFile(target) {
  const resolved = path.resolve(target);
  const looksLikeDir = target.endsWith(path.sep) || target.endsWith('/');
  let isDir = false;
  try {
    isDir = fs.statSync(resolved).isDirectory();
  } catch (e) {
    isDir = false;
  }
  return (isDir || looksLikeDir) ? path.join(resolved, DEFAULT_REGISTRY_NAME) : resolved;
}

function resolveRegistryFile() {
  if (process.env.DOCKER_PORTS_FILE) {
    return asRegistryFile(process.env.DOCKER_PORTS_FILE);
  }

  if (process.env.DOCKER_PORTS_DIR) {
    warn('DOCKER_PORTS_DIR is deprecated; use DOCKER_PORTS_FILE to point at the registry file.');
    return path.join(path.resolve(process.env.DOCKER_PORTS_DIR), DEFAULT_REGISTRY_NAME);
  }

  const userFile = userConfigFile();
  if (fs.existsSync(userFile)) {
    const userCfg = readJsonFile(userFile);
    if (userCfg.registryFile) {
      return path.resolve(userCfg.registryFile);
    }
    if (userCfg.storagePath) {
      // Pre-1.2 config recorded a directory.
      return path.join(path.resolve(userCfg.storagePath), DEFAULT_REGISTRY_NAME);
    }
  }

  return defaultRegistryFile();
}

if (fs.existsSync(LEGACY_LOCAL_CONFIG)) {
  warn(
    `Ignoring ${LEGACY_LOCAL_CONFIG} in this directory: configuration is no longer read ` +
    'per project.\n         Run "docker-ports path <file>" once, then delete it.'
  );
}

const registryFile = resolveRegistryFile();

// Filled in by readRegistry(): the block size governs every overlap check, and
// it always comes from the registry being written to.
let settings = { startPort: DEFAULT_START_PORT, portStep: DEFAULT_PORT_STEP };

function emptyRegistry() {
  return { startPort: DEFAULT_START_PORT, portStep: DEFAULT_PORT_STEP, projects: [] };
}

function initStorage() {
  fs.mkdirSync(path.dirname(registryFile), { recursive: true });
  if (!fs.existsSync(registryFile)) {
    writeRegistry(emptyRegistry());
  }
}

// process.exit() skips finally blocks, and every validation error exits, so the
// lock is released from an exit handler as well: otherwise a rejected command
// would leave the registry locked for everyone else.
const LOCK_TIMEOUT_MS = 10000;
const LOCK_STALE_MS = 30000;

let heldLock = null;

function releaseLock() {
  if (!heldLock) return;
  try {
    fs.rmdirSync(heldLock);
  } catch (e) {
    // Nothing sensible to do if the lock is already gone.
  }
  heldLock = null;
}

process.on('exit', releaseLock);
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLock(fn) {
  initStorage();
  const lockDir = `${registryFile}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  for (;;) {
    try {
      // mkdir is atomic, on NFS too: it fails if another process got there first.
      fs.mkdirSync(lockDir);
      heldLock = lockDir;
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;

      try {
        if (Date.now() - fs.statSync(lockDir).mtimeMs > LOCK_STALE_MS) {
          warn('Removing a stale lock left behind by an interrupted command.');
          fs.rmdirSync(lockDir);
          continue;
        }
      } catch (staleErr) {
        // The lock disappeared while we inspected it; just retry.
      }

      if (Date.now() > deadline) {
        fail(`Timed out waiting for the registry lock (${lockDir}).`);
      }
      sleepSync(20 + Math.floor(Math.random() * 40));
    }
  }

  try {
    return fn();
  } finally {
    releaseLock();
  }
}

function sanitizeSettings(raw) {
  let startPort = raw.startPort === undefined ? DEFAULT_START_PORT : Number(raw.startPort);
  let portStep = raw.portStep === undefined ? DEFAULT_PORT_STEP : Number(raw.portStep);

  if (!Number.isInteger(startPort) || startPort < 1 || startPort > MAX_PORT) {
    warn(`Invalid startPort "${raw.startPort}" in ${registryFile}, falling back to ${DEFAULT_START_PORT}.`);
    startPort = DEFAULT_START_PORT;
  }
  if (!Number.isInteger(portStep) || portStep < 1) {
    warn(`Invalid portStep "${raw.portStep}" in ${registryFile}, falling back to ${DEFAULT_PORT_STEP}.`);
    portStep = DEFAULT_PORT_STEP;
  }
  return { startPort, portStep };
}

function readRegistry() {
  initStorage();
  const raw = fs.readFileSync(registryFile, 'utf8');

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    // Never fall back to an empty registry here: the next write would wipe it.
    fail(
      `The registry at ${registryFile} is not valid JSON (${e.message}).\n` +
      '       Refusing to continue so the existing entries are not overwritten.\n' +
      '       Inspect or restore the file, then retry.'
    );
  }

  // Registries written before 1.2 were a bare array of projects.
  if (Array.isArray(parsed)) {
    settings = { startPort: DEFAULT_START_PORT, portStep: DEFAULT_PORT_STEP };
    return { startPort: settings.startPort, portStep: settings.portStep, projects: parsed };
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.projects)) {
    fail(
      `The registry at ${registryFile} is not in the expected format.\n` +
      '       Expected an object with a "projects" array.'
    );
  }

  settings = sanitizeSettings(parsed);
  return { startPort: settings.startPort, portStep: settings.portStep, projects: parsed.projects };
}

function writeRegistry(registry) {
  const body = {
    startPort: registry.startPort === undefined ? DEFAULT_START_PORT : registry.startPort,
    portStep: registry.portStep === undefined ? DEFAULT_PORT_STEP : registry.portStep,
    projects: registry.projects || []
  };
  // Write to a temporary file in the same directory, then rename: rename is
  // atomic, so an interrupted command can never leave a truncated registry.
  const tmpFile = path.join(
    path.dirname(registryFile),
    `.${path.basename(registryFile)}.${process.pid}.tmp`
  );
  fs.writeFileSync(tmpFile, `${JSON.stringify(body, null, 2)}\n`);
  fs.renameSync(tmpFile, registryFile);
}

function patchUserConfig(patch) {
  const file = userConfigFile();
  const current = fs.existsSync(file) ? readJsonFile(file) : {};
  const merged = Object.assign(current, patch);
  for (const key of Object.keys(merged)) {
    if (merged[key] === undefined) delete merged[key];
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`);
}

// Every project reserves a whole block of portStep ports, so two projects clash
// as soon as their blocks overlap, not only when the base ports match.
function blockEnd(port) {
  return port + settings.portStep - 1;
}

function findOverlap(projects, port, excludeId) {
  return projects.find(p =>
    (!excludeId || p.id.toLowerCase() !== excludeId.toLowerCase()) &&
    Math.abs(p.port - port) < settings.portStep
  );
}

function validatePort(port) {
  if (!Number.isInteger(port)) {
    fail(`Port "${port}" must be a whole number.`);
  }
  if (port < 1 || port > MAX_PORT) {
    fail(`Port ${port} is out of range (1-${MAX_PORT}).`);
  }
  if (blockEnd(port) > MAX_PORT) {
    warn(`The block reserved for port ${port} runs past ${MAX_PORT}.`);
  }
  if (port < 1024) {
    warn(`Port ${port} is privileged (below 1024) and needs elevated rights to bind.`);
  }
}

function assertNoOverlap(projects, port, excludeId) {
  const clash = findOverlap(projects, port, excludeId);
  if (!clash) return;
  const message =
    `Port ${port} overlaps the block reserved for "${clash.id}" ` +
    `(${clash.port}-${blockEnd(clash.port)}).`;
  if (force) {
    warn(`${message} Proceeding because of --force.`);
  } else {
    fail(`${message}\n       Pass --force to register it anyway.`);
  }
}

// Walks the range from startPort and returns the first block nobody occupies,
// so ports freed by `del` come back into circulation.
function nextFreePort(registry) {
  for (let port = registry.startPort; port <= MAX_PORT; port += registry.portStep) {
    if (!findOverlap(registry.projects, port)) return port;
  }
  return null;
}

// Router Command Loops
switch (command) {
  case 'list':
  case 'ls': {
    const registry = readRegistry();
    if (registry.projects.length === 0) {
      console.log(pc.yellow('\nRegistry is empty. Add a project using: docker-ports add <id> [port] [desc]\n'));
      break;
    }
    const sorted = registry.projects.sort((a, b) => a.port - b.port);
    console.log(pc.bold(`\n${'PORT'.padEnd(8)} | ${'PROJECT ID'.padEnd(15)} | DESCRIPTION`));
    console.log('-'.repeat(60));
    sorted.forEach(proj => {
      console.log(`${pc.green(proj.port.toString().padEnd(8))} | ${pc.cyan(proj.id.padEnd(15))} | ${proj.desc || ''}`);
    });
    console.log();
    break;
  }

  case 'next': {
    const port = nextFreePort(readRegistry());
    if (port === null) {
      fail(`No free port block left between ${settings.startPort} and ${MAX_PORT}.`);
    }
    console.log(port);
    break;
  }

  case 'add': {
    const id = args[1];
    const portInput = args[2];

    if (!id) {
      fail('Missing Project ID. Usage: docker-ports add <id> [port] [desc]');
    }

    withLock(() => {
      const registry = readRegistry();
      if (registry.projects.some(p => p.id.toLowerCase() === id.toLowerCase())) {
        fail(`Project ID "${id}" already exists.`);
      }

      let desc = args.slice(3).join(' ');
      let assignedPort;

      if (portInput && !isNaN(portInput)) {
        assignedPort = Number(portInput);
        validatePort(assignedPort);
        assertNoOverlap(registry.projects, assignedPort);
      } else {
        if (portInput) {
          desc = args.slice(2).join(' ');
        }
        assignedPort = nextFreePort(registry);
        if (assignedPort === null) {
          fail(`No free port block left between ${registry.startPort} and ${MAX_PORT}.`);
        }
      }

      registry.projects.push({ port: assignedPort, id, desc: desc || '' });
      writeRegistry(registry);

      console.log(pc.green(`✔ Success: Registered "${id}" on base port ${assignedPort}`));
    });
    break;
  }

  case 'update': {
    const id = args[1];
    const portInput = args[2];
    const desc = args.slice(3).join(' ');

    if (!id || !portInput || isNaN(portInput)) {
      fail('Update requires an ID and a numeric Port. Usage: docker-ports update <id> <port> [desc]');
    }

    const newPort = Number(portInput);

    withLock(() => {
      const registry = readRegistry();
      validatePort(newPort);

      if (!registry.projects.some(p => p.id.toLowerCase() === id.toLowerCase())) {
        fail(`Project ID "${id}" not found.`);
      }
      assertNoOverlap(registry.projects, newPort, id);

      registry.projects = registry.projects.map(p => (
        p.id.toLowerCase() === id.toLowerCase()
          ? Object.assign({}, p, { port: newPort, desc: desc || p.desc })
          : p
      ));

      writeRegistry(registry);
      console.log(pc.green(`✔ Success: Updated project "${id}" to port ${newPort}`));
    });
    break;
  }

  case 'del':
  case 'rm': {
    const id = args[1];
    if (!id) {
      fail('Missing Project ID to remove.');
    }

    withLock(() => {
      const registry = readRegistry();
      const remaining = registry.projects.filter(p => p.id.toLowerCase() !== id.toLowerCase());

      if (registry.projects.length === remaining.length) {
        fail(`Project ID "${id}" not found.`);
      }

      registry.projects = remaining;
      writeRegistry(registry);
      console.log(pc.green(`✔ Success: Removed "${id}" from the shared registry.`));
    });
    break;
  }

  case 'path': {
    const target = args[1];

    if (!target) {
      console.log(`Registry file: ${registryFile}`);
      if (process.env.DOCKER_PORTS_FILE || process.env.DOCKER_PORTS_DIR) {
        console.log(pc.dim('  chosen by the environment for this command'));
      } else if (registryFile === defaultRegistryFile()) {
        console.log(pc.dim('  the default location'));
      } else {
        console.log(pc.dim(`  recorded for your user in: ${userConfigFile()}`));
      }
      if (fs.existsSync(registryFile)) {
        const registry = readRegistry();
        console.log(pc.dim(`  ${registry.projects.length} project(s), ports from ${registry.startPort}, blocks of ${registry.portStep}`));
      } else {
        console.log(pc.dim('  not created yet'));
      }
      break;
    }

    if (target === '--reset') {
      const userFile = userConfigFile();
      const hadSetting = fs.existsSync(userFile) &&
        (readJsonFile(userFile).registryFile || readJsonFile(userFile).storagePath);

      if (hadSetting) {
        patchUserConfig({ registryFile: undefined, storagePath: undefined });
        console.log(pc.green(`✔ Back to the default registry file: ${defaultRegistryFile()}`));
      } else {
        console.log(pc.yellow(`Nothing to reset: no registry file recorded in ${userFile}.`));
      }

      if (fs.existsSync(LEGACY_LOCAL_CONFIG)) {
        fs.unlinkSync(LEGACY_LOCAL_CONFIG);
        console.log(pc.green(`✔ Removed the obsolete ${LEGACY_LOCAL_CONFIG} from this directory.`));
      }
    } else {
      const targetFile = asRegistryFile(target);
      patchUserConfig({ registryFile: targetFile, storagePath: undefined });
      console.log(pc.green(`✔ Registry file set to: ${targetFile}`));
      console.log(pc.dim('  This applies to every directory you run docker-ports from.'));

      // Say what joining this registry means, so nobody has to ask a colleague
      // which range they agreed on.
      if (fs.existsSync(targetFile)) {
        const joined = readJsonFile(targetFile);
        const joinedStart = Array.isArray(joined) ? DEFAULT_START_PORT : (joined.startPort || DEFAULT_START_PORT);
        const joinedStep = Array.isArray(joined) ? DEFAULT_PORT_STEP : (joined.portStep || DEFAULT_PORT_STEP);
        const count = Array.isArray(joined) ? joined.length : (joined.projects || []).length;
        console.log(pc.dim(`  Joined an existing registry: ${count} project(s), ports from ${joinedStart}, blocks of ${joinedStep}.`));
      } else {
        console.log(pc.dim('  New registry. Run "docker-ports start <port> [step]" to set the range everyone will share.'));
      }
    }
    break;
  }

  case 'start': {
    const portValue = args[1];
    const stepValue = args[2] || DEFAULT_PORT_STEP;

    if (!portValue || isNaN(portValue) || isNaN(stepValue)) {
      fail('Requires a valid numeric starting port limit. Usage: docker-ports start <port> [step]');
    }

    const startPort = Number(portValue);
    const portStep = Number(stepValue);

    if (!Number.isInteger(startPort) || startPort < 1 || startPort > MAX_PORT) {
      fail(`Starting port ${portValue} is out of range (1-${MAX_PORT}).`);
    }
    if (!Number.isInteger(portStep) || portStep < 1) {
      fail(`Step ${stepValue} must be a whole number of at least 1.`);
    }

    withLock(() => {
      const registry = readRegistry();

      // Widening the step can make blocks that used to be disjoint overlap, and
      // this setting is shared, so say so instead of letting it surface later.
      if (portStep > registry.portStep) {
        const ports = registry.projects.map(p => p.port).sort((a, b) => a - b);
        const clashes = ports.filter((p, i) => i > 0 && p - ports[i - 1] < portStep);
        if (clashes.length > 0) {
          warn(`Step ${portStep} makes ${clashes.length} already registered project(s) overlap.`);
        }
      }

      registry.startPort = startPort;
      registry.portStep = portStep;
      writeRegistry(registry);

      console.log(pc.green(`✔ Success: Range config updated to start at ${startPort} with step jumps of ${portStep}.`));
      console.log(pc.dim(`  Stored in ${registryFile}, shared with everyone using it.`));
    });
    break;
  }

  default:
    console.error(pc.red(`Unknown command: "${command}"`));
    showHelp();
    process.exit(1);
}
