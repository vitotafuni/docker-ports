#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const pc = require('picocolors');

// Load metadata dynamically
const pkgPath = path.join(__dirname, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

const args = process.argv.slice(2);
const command = args[0];

function showHelp() {
  console.log(pc.bold(`\nDocker Project Port Manager (v${pkg.version})`));
  console.log('\nUsage:');
  console.log('  docker-ports <command> [arguments]');
  console.log('\nCommands:');
  console.log(`  list                      ${pc.dim('- Show all registered base ports')}`);
  console.log(`  next                      ${pc.dim('- Get the next available base port number')}`);
  console.log(`  add <id> [port] [desc]    ${pc.dim('- Add a project (auto-calculates port if omitted)')}`);
  console.log(`  update <id> <port> [desc] ${pc.dim('- Update an existing project port and description')}`);
  console.log(`  del <id>                  ${pc.dim('- Remove a project from the registry')}`);
  console.log(`  path [dir]                ${pc.dim('- View or update configuration workspace path')}`);
  console.log(`  path --reset              ${pc.dim('- Reset local path back to system defaults')}`);
  console.log(`  start <port> [step]       ${pc.dim('- Set range starting boundary and step interval')}`);
  console.log('\nOptions:');
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

// Config resolution logic
const LOCAL_CONFIG_FILE = '.docker-ports-config.json';
const GLOBAL_CONFIG_DIR = path.join(process.env.HOME || process.env.USERPROFILE, '.docker-ports');

function resolveConfigPaths() {
  let storageDir = GLOBAL_CONFIG_DIR;
  let startPort = 8000;
  let portStep = 10;

  if (fs.existsSync(LOCAL_CONFIG_FILE)) {
    try {
      const localCfg = JSON.parse(fs.readFileSync(LOCAL_CONFIG_FILE, 'utf8'));
      if (localCfg.storagePath) storageDir = localCfg.storagePath;
      if (localCfg.startPort) startPort = Number(localCfg.startPort);
      if (localCfg.portStep) portStep = Number(localCfg.portStep);
    } catch (e) {}
  } else {
    const globalCfgFile = path.join(GLOBAL_CONFIG_DIR, 'config.json');
    if (fs.existsSync(globalCfgFile)) {
      try {
        const globalCfg = JSON.parse(fs.readFileSync(globalCfgFile, 'utf8'));
        if (globalCfg.storagePath) storageDir = globalCfg.storagePath;
        if (globalCfg.startPort) startPort = Number(globalCfg.startPort);
        if (globalCfg.portStep) portStep = Number(globalCfg.portStep);
      } catch (e) {}
    }
  }

  if (process.env.DOCKER_PORTS_DIR) {
    storageDir = process.env.DOCKER_PORTS_DIR;
  }

  return {
    storageDir,
    dbFile: path.join(storageDir, 'projects.json'),
    startPort,
    portStep
  };
}

const config = resolveConfigPaths();

function initStorage() {
  if (!fs.existsSync(config.storageDir)) {
    fs.mkdirSync(config.storageDir, { recursive: true });
  }
  if (!fs.existsSync(config.dbFile)) {
    fs.writeFileSync(config.dbFile, JSON.stringify([], null, 2));
  }
}

function readData() {
  initStorage();
  try {
    return JSON.parse(fs.readFileSync(config.dbFile, 'utf8'));
  } catch (e) {
    return [];
  }
}

function writeData(data) {
  fs.writeFileSync(config.dbFile, JSON.stringify(data, null, 2));
}

// Router Command Loops
switch (command) {
  case 'list':
  case 'ls': {
    const data = readData();
    if (data.length === 0) {
      console.log(pc.yellow('\nRegistry is empty. Add a project using: docker-ports add <id> [port] [desc]\n'));
      break;
    }
    const sorted = data.sort((a, b) => a.port - b.port);
    console.log(pc.bold(`\n${'PORT'.padEnd(8)} | ${'PROJECT ID'.padEnd(15)} | DESCRIPTION`));
    console.log('-'.repeat(60));
    sorted.forEach(proj => {
      console.log(`${pc.green(proj.port.toString().padEnd(8))} | ${pc.cyan(proj.id.padEnd(15))} | ${proj.desc || ''}`);
    });
    console.log();
    break;
  }

  case 'next': {
    const data = readData();
    const ports = data.map(p => p.port);
    if (ports.length === 0) {
      console.log(config.startPort);
    } else {
      const maxPort = Math.max(...ports);
      console.log(maxPort + config.portStep);
    }
    break;
  }

  case 'add': {
    const id = args[1];
    let portInput = args[2];
    let desc = args.slice(3).join(' ');

    if (!id) {
      console.error(pc.red('Error: Missing Project ID. Usage: docker-ports add <id> [port] [desc]'));
      process.exit(1);
    }

    const data = readData();
    if (data.some(p => p.id.toLowerCase() === id.toLowerCase())) {
      console.error(pc.red(`Error: Project ID "${id}" already exists.`));
      process.exit(1);
    }

    let assignedPort;
    if (portInput && !isNaN(portInput)) {
      assignedPort = Number(portInput);
    } else {
      if (portInput) {
        desc = args.slice(2).join(' ');
      }
      const ports = data.map(p => p.port);
      if (ports.length === 0) {
        assignedPort = config.startPort;
      } else {
        assignedPort = Math.max(...ports) + config.portStep;
      }
    }

    data.push({ port: assignedPort, id, desc: desc || '' });
    writeData(data);

    console.log(pc.green(`✔ Success: Registered "${id}" on base port ${assignedPort}`));
    break;
  }

  case 'update': {
    const id = args[1];
    const portInput = args[2];
    const desc = args.slice(3).join(' ');

    if (!id || !portInput || isNaN(portInput)) {
      console.error(pc.red('Error: Update requires an ID and a numeric Port. Usage: docker-ports update <id> <port> [desc]'));
      process.exit(1);
    }

    let data = readData();
    let found = false;

    data = data.map(p => {
      if (p.id.toLowerCase() === id.toLowerCase()) {
        found = true;
        return { ...p, port: Number(portInput), desc: desc || p.desc };
      }
      return p;
    });

    if (!found) {
      console.error(pc.red(`Error: Project ID "${id}" not found.`));
      process.exit(1);
    }

    writeData(data);
    console.log(pc.green(`✔ Success: Updated project "${id}" to port ${portInput}`));
    break;
  }

  case 'del':
  case 'rm': {
    const id = args[1];
    if (!id) {
      console.error(pc.red('Error: Missing Project ID to remove.'));
      process.exit(1);
    }

    const data = readData();
    const filtered = data.filter(p => p.id.toLowerCase() !== id.toLowerCase());

    if (data.length === filtered.length) {
      console.error(pc.red(`Error: Project ID "${id}" not found.`));
      process.exit(1);
    }

    writeData(filtered);
    console.log(pc.green(`✔ Success: Removed "${id}" from the shared registry.`));
    break;
  }

  case 'path': {
    const targetDir = args[1];
    if (!targetDir) {
      console.log(`Current storage directory configuration: ${config.storageDir}`);
      break;
    }

    if (targetDir === '--reset') {
      if (fs.existsSync(LOCAL_CONFIG_FILE)) {
        fs.unlinkSync(LOCAL_CONFIG_FILE);
      }
      console.log(pc.green('✔ Workspace path references reset back to host system defaults.'));
    } else {
      const absolutePath = path.resolve(targetDir);
      const cfgData = { storagePath: absolutePath };
      fs.writeFileSync(LOCAL_CONFIG_FILE, JSON.stringify(cfgData, null, 2));
      console.log(pc.green(`✔ Local workspace storage path shifted to: ${absolutePath}`));
    }
    break;
  }

  case 'start': {
    const portValue = args[1];
    const stepValue = args[2] || 10;

    if (!portValue || isNaN(portValue) || isNaN(stepValue)) {
      console.error(pc.red('Error: Requires a valid numeric starting port limit. Usage: docker-ports start <port> [step]'));
      process.exit(1);
    }

    let currentCfg = {};
    if (fs.existsSync(LOCAL_CONFIG_FILE)) {
      try { currentCfg = JSON.parse(fs.readFileSync(LOCAL_CONFIG_FILE, 'utf8')); } catch(e) {}
    }

    currentCfg.startPort = Number(portValue);
    currentCfg.portStep = Number(stepValue);

    fs.writeFileSync(LOCAL_CONFIG_FILE, JSON.stringify(currentCfg, null, 2));
    console.log(pc.green(`✔ Success: Range config updated to start at ${portValue} with step jumps of ${stepValue}.`));
    break;
  }

  default:
    console.error(pc.red(`Unknown command: "${command}"`));
    showHelp();
    process.exit(1);
}
