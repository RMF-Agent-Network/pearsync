#!/usr/bin/env node

/**
 * PearSync CLI - P2P File Sharing
 *
 * Commands:
 *   init <path> --name <alias>      Create a new shared workspace
 *   join <key> <path> --name <alias> Join an existing workspace
 *   watch [name]                     Watch and sync continuously
 *   status [name]                    Show workspace info
 *   list                            List all workspaces
 *   remove <name>                   Remove workspace configuration
 *   daemon start|stop|status        Manage background daemon
 */

import { SyncEngine, DEFAULT_IGNORES } from '../lib/sync.js'
import * as config from '../lib/config.js'
import path from 'path'
import os from 'os'
import goodbye from 'graceful-goodbye'
import { Daemon } from '../lib/daemon.js'
import { DaemonClient } from '../lib/daemon-client.js'

// ANSI colors
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
  cyan: '\x1b[36m'
}

function log(msg, color = '') {
  const timestamp = new Date().toLocaleTimeString()
  console.log(`${colors.dim}[${timestamp}]${colors.reset} ${color}${msg}${colors.reset}`)
}

function logSuccess(msg) { log(msg, colors.green) }
function logInfo(msg) { log(msg, colors.blue) }
function logWarn(msg) { log(msg, colors.yellow) }
function logError(msg) { log(msg, colors.red) }

const DAEMON_SOCKET = path.join(os.homedir(), '.config', 'pearsync', 'daemon.sock')

function printHelp() {
  console.log(`
${colors.bright}pearsync${colors.reset} - P2P File Sharing

${colors.bright}USAGE:${colors.reset}
  pearsync <command> [options]

${colors.bright}COMMANDS:${colors.reset}
  ${colors.cyan}init${colors.reset} <path> --name <alias>       Create a new shared workspace
  ${colors.cyan}join${colors.reset} <key> <path> --name <alias>  Join an existing workspace
  ${colors.cyan}watch${colors.reset} <name>                      Watch and sync continuously
  ${colors.cyan}status${colors.reset} [name]                     Show workspace info
  ${colors.cyan}list${colors.reset}                              List all workspaces
  ${colors.cyan}remove${colors.reset} <name> [--delete-data]     Remove workspace from config
  ${colors.cyan}daemon${colors.reset} start|stop|status          Manage background daemon

${colors.bright}OPTIONS:${colors.reset}
  --name <alias>    Name for the workspace (required for init/join)
  --no-delete       Don't sync deletions (keep local files)
  --delete-data     Also delete hypercore data when removing
  --verbose         Show detailed output
  --foreground      Run watch in foreground (bypass daemon)

${colors.bright}EXAMPLES:${colors.reset}
  # Create a shared folder
  pearsync init ~/shared --name robby-hal

  # Join from another machine
  pearsync join abc123... ~/shared --name robby-hal

  # Start syncing
  pearsync watch robby-hal

  # Check status
  pearsync status robby-hal
  pearsync list

${colors.bright}STORAGE:${colors.reset}
  Config: ${config.CONFIG_PATH}
  Data:   ${config.STORES_PATH}

${colors.bright}IGNORED FILES:${colors.reset}
  ${DEFAULT_IGNORES.join(', ')}
  (customize with .pearsyncignore)
`)
}

/**
 * Parse command line arguments
 */
function parseArgs(args) {
  const flags = {}
  const positionals = []
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      
      // Handle --no-* flags
      if (key.startsWith('no-')) {
        flags[key.slice(3)] = false
      } else if (args[i + 1] && !args[i + 1].startsWith('--')) {
        flags[key] = args[i + 1]
        i++
      } else {
        flags[key] = true
      }
    } else {
      positionals.push(arg)
    }
  }
  
  return { flags, positionals }
}

/**
 * Create event handlers for a sync engine
 */
function setupEventHandlers(engine, verbose = false) {
  engine.on('status', (msg) => logInfo(msg))
  engine.on('error', (err) => logError(`Error: ${err.error} (${err.type})`))
  
  engine.on('peer-join', ({ peerId, total }) => {
    logSuccess(`Peer connected: ${peerId} (${total} total)`)
  })
  
  engine.on('peer-leave', ({ peerId, total }) => {
    logWarn(`Peer disconnected: ${peerId} (${total} total)`)
  })
  
  engine.on('sync-start', ({ direction }) => {
    if (verbose) logInfo(`Syncing ${direction}...`)
  })
  
  engine.on('sync-complete', ({ direction, count }) => {
    if (count && (count.files || count.add || count.remove || count.change)) {
      logSuccess(`Sync complete ${direction}: ${JSON.stringify(count)}`)
    } else if (verbose) {
      log(`Sync complete ${direction}: No changes`, colors.dim)
    }
  })
  
  engine.on('watch-start', () => logInfo('Watching for changes...'))
  engine.on('watch-stop', () => logInfo('Stopped watching'))
  engine.on('close', () => logInfo('Workspace closed'))
}

// ============ Commands ============

async function cmdInit(localPath, flags) {
  const name = flags.name
  if (!name) {
    logError('Missing --name argument')
    console.log('Usage: pearsync init <path> --name <alias>')
    process.exit(1)
  }
  
  const absPath = path.resolve(localPath)
  
  // Check if name already exists
  const existing = await config.getWorkspace(name)
  if (existing) {
    logError(`Workspace '${name}' already exists`)
    process.exit(1)
  }
  
  // Check if path is already used
  const byPath = await config.getWorkspaceByPath(absPath)
  if (byPath) {
    logError(`Path already used by workspace '${byPath.name}'`)
    process.exit(1)
  }
  
  logInfo(`Creating workspace '${name}' at: ${absPath}`)
  
  // Ensure data directories exist
  await config.ensureDataDirs()
  
  // Create temporary storage path (will be updated with actual key)
  const tempKey = 'temp-' + Date.now()
  const storagePath = config.getStorePath(tempKey)
  
  const engine = new SyncEngine({
    localPath: absPath,
    storagePath,
    syncDeletes: flags.delete !== false
  })
  
  setupEventHandlers(engine, flags.verbose)
  
  try {
    const key = await engine.init()
    
    // Do initial sync (local → remote) before closing
    await engine.syncToRemote()
    
    // Close engine before moving storage
    await engine.close()
    
    // Move storage to correct location based on actual key
    const actualStoragePath = config.getStorePath(key)
    if (storagePath !== actualStoragePath) {
      const fs = await import('fs/promises')
      await fs.rename(storagePath, actualStoragePath)
    }
    
    // Save to config
    await config.addWorkspace(name, {
      key,
      path: absPath,
      isWriter: true,
      syncDeletes: flags.delete !== false
    })
    
    // Reopen engine for seeding (use ownKey to open existing drive we created)
    const seedEngine = new SyncEngine({
      localPath: absPath,
      storagePath: actualStoragePath,
      ownKey: key,  // Reopen as writer
      syncDeletes: flags.delete !== false
    })
    setupEventHandlers(seedEngine, flags.verbose)
    await seedEngine.init()
    
    console.log('')
    console.log(`${colors.bright}${colors.green}✓ Workspace '${name}' created!${colors.reset}`)
    console.log('')
    console.log(`${colors.bright}Share this key:${colors.reset}`)
    console.log(`${colors.cyan}${key}${colors.reset}`)
    console.log('')
    console.log(`${colors.dim}Others can join with:${colors.reset}`)
    console.log(`${colors.dim}  pearsync join ${key} <path> --name ${name}${colors.reset}`)
    console.log('')
    
    // Keep running briefly to seed
    logInfo('Seeding to network for 10 seconds (Ctrl+C to stop earlier)...')
    
    goodbye(async () => {
      await seedEngine.close()
    })
    
    await new Promise(resolve => setTimeout(resolve, 10000))
    await seedEngine.close()
    
  } catch (err) {
    logError(`Failed to initialize: ${err.message}`)
    process.exit(1)
  }
}

async function cmdJoin(key, localPath, flags) {
  const name = flags.name
  if (!name) {
    logError('Missing --name argument')
    console.log('Usage: pearsync join <key> <path> --name <alias>')
    process.exit(1)
  }
  
  // Validate key
  if (!config.isValidKey(key)) {
    logError('Invalid key format. Expected 64 hex characters.')
    process.exit(1)
  }
  
  const absPath = path.resolve(localPath)
  
  // Check if name already exists
  const existing = await config.getWorkspace(name)
  if (existing) {
    logError(`Workspace '${name}' already exists`)
    process.exit(1)
  }
  
  // Check if path is already used
  const byPath = await config.getWorkspaceByPath(absPath)
  if (byPath) {
    logError(`Path already used by workspace '${byPath.name}'`)
    process.exit(1)
  }
  
  logInfo(`Joining workspace '${name}' at: ${absPath}`)
  logInfo(`Remote key: ${key.slice(0, 16)}...`)
  
  await config.ensureDataDirs()
  
  const storagePath = config.getStorePath(key)
  
  const engine = new SyncEngine({
    localPath: absPath,
    storagePath,
    remoteKey: key,
    syncDeletes: flags.delete !== false
  })
  
  setupEventHandlers(engine, flags.verbose)
  
  try {
    await engine.init()
    
    // Save to config
    await config.addWorkspace(name, {
      key,
      path: absPath,
      isWriter: false,
      syncDeletes: flags.delete !== false
    })
    
    logInfo('Waiting for peers (up to 60s)...')
    
    // Wait for peer connection or timeout
    const waitForPeer = new Promise(resolve => {
      const timeout = setTimeout(() => resolve(false), 60000)
      engine.once('peer-join', () => {
        clearTimeout(timeout)
        resolve(true)
      })
    })
    
    const foundPeer = await waitForPeer
    if (!foundPeer) {
      logWarn('No peers found yet. Files will sync when a peer connects.')
      logInfo('Run "pearsync watch ' + name + '" to keep trying.')
    }
    
    // Sync remote → local
    await engine.syncToLocal()
    
    const info = await engine.getInfo()
    
    console.log('')
    console.log(`${colors.bright}${colors.green}✓ Joined workspace '${name}'!${colors.reset}`)
    console.log('')
    console.log(`Files: ${info.fileCount}`)
    console.log(`Size: ${(info.totalSize / 1024).toFixed(1)} KB`)
    console.log(`Peers: ${info.peers}`)
    console.log('')
    
    await engine.close()
    
  } catch (err) {
    logError(`Failed to join: ${err.message}`)
    process.exit(1)
  }
}

async function cmdWatch(name, flags) {
  if (!name) {
    // Try to find workspace by current directory
    const cwd = process.cwd()
    const ws = await config.getWorkspaceByPath(cwd)
    if (ws) {
      name = ws.name
    } else {
      logError('No workspace name provided and current directory is not a workspace')
      console.log('Usage: pearsync watch <name>')
      process.exit(1)
    }
  }

  const workspace = await config.getWorkspace(name)
  if (!workspace) {
    logError(`Workspace '${name}' not found`)
    console.log('Run "pearsync list" to see available workspaces')
    process.exit(1)
  }

  // Check if daemon is running and --foreground is not set
  if (!flags.foreground) {
    const isRunning = await DaemonClient.isRunning(DAEMON_SOCKET)
    if (isRunning) {
      // Delegate to daemon
      const client = new DaemonClient(DAEMON_SOCKET)
      try {
        const response = await client.watch(workspace.path)
        if (response.success) {
          logSuccess(`Workspace added to daemon: ${workspace.path}`)
          logInfo('Run "pearsync daemon status" to see active workspaces')
          return
        } else if (response.error) {
          logWarn(`Daemon error: ${response.error}`)
          logInfo('Falling back to foreground mode')
        }
      } catch (err) {
        logWarn(`Could not connect to daemon: ${err.message}`)
        logInfo('Falling back to foreground mode')
      }
    }
  }

  // Run in foreground (either --foreground set or daemon not running)
  logInfo(`Watching workspace '${name}'${flags.foreground ? ' (foreground mode)' : ''}`)
  logInfo(`Path: ${workspace.path}`)
  logInfo(`Mode: ${workspace.isWriter ? 'Writer (local→remote)' : 'Reader (remote→local)'}`)

  const storagePath = config.getStorePath(workspace.key)
  
  const engine = new SyncEngine({
    localPath: workspace.path,
    storagePath,
    remoteKey: workspace.isWriter ? null : workspace.key,
    ownKey: workspace.isWriter ? workspace.key : null,  // Reopen our own workspace
    syncDeletes: flags.delete !== false && workspace.syncDeletes
  })
  
  setupEventHandlers(engine, flags.verbose)
  
  // Handle graceful shutdown
  goodbye(async () => {
    logInfo('Shutting down...')
    await engine.close()
  })
  
  try {
    await engine.init()
    
    // Initial sync
    if (workspace.isWriter) {
      await engine.syncToRemote()
    } else {
      await engine.syncToLocal()
    }
    
    // Start watching
    await engine.startWatching()
    
    console.log('')
    console.log(`${colors.green}Watching for changes. Press Ctrl+C to stop.${colors.reset}`)
    console.log('')
    
    // Keep running
    await new Promise(() => {})
    
  } catch (err) {
    logError(`Watch failed: ${err.message}`)
    process.exit(1)
  }
}

async function cmdStatus(name, flags) {
  if (!name) {
    // Try current directory
    const cwd = process.cwd()
    const ws = await config.getWorkspaceByPath(cwd)
    if (ws) {
      name = ws.name
    } else {
      logError('No workspace name provided')
      console.log('Usage: pearsync status <name>')
      process.exit(1)
    }
  }
  
  const workspace = await config.getWorkspace(name)
  if (!workspace) {
    logError(`Workspace '${name}' not found`)
    process.exit(1)
  }
  
  const storagePath = config.getStorePath(workspace.key)
  
  const engine = new SyncEngine({
    localPath: workspace.path,
    storagePath,
    remoteKey: workspace.isWriter ? null : workspace.key,
    ownKey: workspace.isWriter ? workspace.key : null
  })
  
  engine.on('error', () => {}) // Suppress errors for status
  
  try {
    await engine.init()
    
    // Brief wait for peers
    await new Promise(resolve => setTimeout(resolve, 3000))
    
    const info = await engine.getInfo()
    
    console.log('')
    console.log(`${colors.bright}Workspace: ${name}${colors.reset}`)
    console.log(`${'─'.repeat(50)}`)
    console.log(`Path:          ${workspace.path}`)
    console.log(`Key:           ${info.key}`)
    console.log(`Mode:          ${info.isWriter ? 'Writer' : 'Reader'}`)
    console.log(`Version:       ${info.version}`)
    console.log(`Files:         ${info.fileCount}`)
    console.log(`Total Size:    ${(info.totalSize / 1024).toFixed(1)} KB`)
    console.log(`Peers:         ${info.peers}`)
    console.log(`Sync Deletes:  ${workspace.syncDeletes ? 'Yes' : 'No'}`)
    console.log(`Created:       ${workspace.created}`)
    console.log(`${'─'.repeat(50)}`)
    console.log('')
    
    await engine.close()
    
  } catch (err) {
    logError(`Status failed: ${err.message}`)
    process.exit(1)
  }
}

async function cmdList(flags) {
  const workspaces = await config.listWorkspaces()
  
  if (workspaces.length === 0) {
    console.log('')
    console.log(`${colors.dim}No workspaces configured.${colors.reset}`)
    console.log('')
    console.log('Create one with:')
    console.log('  pearsync init <path> --name <alias>')
    console.log('')
    return
  }
  
  console.log('')
  console.log(`${colors.bright}Configured Workspaces${colors.reset}`)
  console.log(`${'─'.repeat(70)}`)
  
  for (const ws of workspaces) {
    const mode = ws.isWriter ? 'writer' : 'reader'
    console.log(`${colors.cyan}${ws.name.padEnd(20)}${colors.reset} ${ws.path}`)
    console.log(`${' '.repeat(20)} ${colors.dim}${mode} | ${ws.key.slice(0, 16)}...${colors.reset}`)
  }
  
  console.log(`${'─'.repeat(70)}`)
  console.log(`Total: ${workspaces.length} workspace(s)`)
  console.log('')
}

async function cmdRemove(name, flags) {
  if (!name) {
    logError('Missing workspace name')
    console.log('Usage: pearsync remove <name> [--delete-data]')
    process.exit(1)
  }
  
  const workspace = await config.getWorkspace(name)
  if (!workspace) {
    logError(`Workspace '${name}' not found`)
    process.exit(1)
  }
  
  const deleteData = flags['delete-data'] || false
  
  console.log('')
  console.log(`Removing workspace '${name}'`)
  console.log(`  Path: ${workspace.path}`)
  console.log(`  Delete data: ${deleteData ? 'Yes' : 'No'}`)
  console.log('')
  
  try {
    await config.removeWorkspace(name, deleteData)
    logSuccess(`Workspace '${name}' removed from config`)
    
    if (!deleteData) {
      logInfo(`Hypercore data preserved at: ${config.getStorePath(workspace.key)}`)
      logInfo('Use --delete-data to also remove stored data')
    }
    
    console.log('')
  } catch (err) {
    logError(`Failed to remove: ${err.message}`)
    process.exit(1)
  }
}

// ============ Daemon Commands ============

async function cmdDaemon(subcommand, flags) {
  const client = new DaemonClient(DAEMON_SOCKET)

  switch (subcommand) {
    case 'start': {
      // Check if already running
      const isRunning = await DaemonClient.isRunning(DAEMON_SOCKET)
      if (isRunning) {
        logWarn('Daemon already running')
        return
      }

      const daemon = new Daemon(DAEMON_SOCKET)
      await daemon.start()
      logSuccess('Daemon started')
      console.log(`Socket: ${DAEMON_SOCKET}`)

      // Keep daemon running
      await new Promise(() => {})
      break
    }

    case 'stop': {
      try {
        const status = await client.status()
        if (!status.running) {
          logInfo('Daemon not running')
          return
        }

        // Request shutdown via IPC
        await client.send({ command: 'shutdown' })
        logSuccess('Daemon stopped')
      } catch (err) {
        logInfo('Daemon not running')
      }
      break
    }

    case 'status': {
      try {
        const status = await client.status()
        console.log('')
        console.log(`${colors.bright}Daemon Status${colors.reset}`)
        console.log(`${'─'.repeat(50)}`)
        console.log(`Running:   ${status.running ? colors.green + 'Yes' + colors.reset : colors.red + 'No' + colors.reset}`)
        console.log(`Socket:    ${status.socketPath}`)
        console.log(`Workspaces: ${status.workspaces.length}`)
        console.log('')

        if (status.workspaces.length > 0) {
          console.log(`${colors.bright}Active Workspaces:${colors.reset}`)
          for (const ws of status.workspaces) {
            console.log(`  ${colors.cyan}${ws.path}${colors.reset}`)
            console.log(`    Started: ${ws.startedAt}`)
            console.log(`    Status:  ${ws.status}`)
          }
          console.log('')
        }
      } catch (err) {
        console.log('')
        console.log(`${colors.bright}Daemon Status${colors.reset}`)
        console.log(`${'─'.repeat(50)}`)
        console.log(`Running:   ${colors.red}No${colors.reset}`)
        console.log('')
      }
      break
    }

    default:
      logError(`Unknown daemon command: ${subcommand}`)
      console.log('Usage: pearsync daemon start|stop|status')
      process.exit(1)
  }
}

// ============ Main ============

async function main() {
  const { flags, positionals } = parseArgs(process.argv.slice(2))
  const command = positionals[0]
  
  if (!command || command === 'help' || flags.help || flags.h) {
    printHelp()
    process.exit(0)
  }
  
  switch (command) {
    case 'init':
      if (!positionals[1]) {
        logError('Missing path argument')
        console.log('Usage: pearsync init <path> --name <alias>')
        process.exit(1)
      }
      await cmdInit(positionals[1], flags)
      break
      
    case 'join':
      if (!positionals[1] || !positionals[2]) {
        logError('Missing arguments')
        console.log('Usage: pearsync join <key> <path> --name <alias>')
        process.exit(1)
      }
      await cmdJoin(positionals[1], positionals[2], flags)
      break
      
    case 'watch':
      await cmdWatch(positionals[1], flags)
      break
      
    case 'status':
      await cmdStatus(positionals[1], flags)
      break
      
    case 'list':
    case 'ls':
      await cmdList(flags)
      break
      
    case 'remove':
    case 'rm':
      await cmdRemove(positionals[1], flags)
      break

    case 'daemon':
      await cmdDaemon(positionals[1], flags)
      break

    default:
      logError(`Unknown command: ${command}`)
      printHelp()
      process.exit(1)
  }
}

main().catch(err => {
  logError(`Unexpected error: ${err.message}`)
  console.error(err)
  process.exit(1)
})
