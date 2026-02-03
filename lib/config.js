/**
 * Config Manager for PearSync
 * 
 * Handles XDG-compliant configuration storage:
 * - Config: ~/.config/pearsync/config.json
 * - Data: ~/.local/share/pearsync/stores/
 */

import fs from 'fs/promises'
import path from 'path'
import os from 'os'

// XDG Base Directory paths
const CONFIG_DIR = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
const DATA_DIR = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share')

export const CONFIG_PATH = path.join(CONFIG_DIR, 'pearsync', 'config.json')
export const STORES_PATH = path.join(DATA_DIR, 'pearsync', 'stores')
export const TRANSFERS_PATH = path.join(DATA_DIR, 'pearsync', 'transfers')

/**
 * Default configuration
 */
const DEFAULT_CONFIG = {
  version: 1,
  workspaces: {},
  defaults: {
    syncDeletes: true,
    pollInterval: 3000
  }
}

/**
 * Load configuration from disk
 * @returns {Promise<Object>} Config object
 */
export async function loadConfig() {
  try {
    const data = await fs.readFile(CONFIG_PATH, 'utf-8')
    const config = JSON.parse(data)
    
    // Validate version
    if (config.version !== 1) {
      throw new Error(`Unknown config version: ${config.version}`)
    }
    
    return { ...DEFAULT_CONFIG, ...config }
  } catch (err) {
    if (err.code === 'ENOENT') {
      // No config file, return default
      return { ...DEFAULT_CONFIG }
    }
    throw err
  }
}

/**
 * Save configuration to disk
 * @param {Object} config - Config object to save
 */
export async function saveConfig(config) {
  // Ensure directory exists
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true })
  
  // Write atomically (write to temp, then rename)
  const tempPath = CONFIG_PATH + '.tmp'
  await fs.writeFile(tempPath, JSON.stringify(config, null, 2))
  await fs.rename(tempPath, CONFIG_PATH)
}

/**
 * Get storage path for a workspace key
 * @param {string} key - 64-char hex key
 * @returns {string} Path to store directory
 */
export function getStorePath(key) {
  // Use first 16 chars of key as folder name
  const prefix = key.slice(0, 16)
  return path.join(STORES_PATH, prefix)
}

/**
 * Add a workspace to config
 * @param {string} name - Workspace alias
 * @param {Object} workspace - Workspace details
 */
export async function addWorkspace(name, workspace) {
  const config = await loadConfig()
  
  // Check if name already exists
  if (config.workspaces[name]) {
    throw new Error(`Workspace '${name}' already exists`)
  }
  
  // Check if path is already used by another workspace
  for (const [existingName, ws] of Object.entries(config.workspaces)) {
    if (ws.path === workspace.path) {
      throw new Error(`Path already used by workspace '${existingName}'`)
    }
  }
  
  config.workspaces[name] = {
    key: workspace.key,
    path: workspace.path,
    isWriter: workspace.isWriter,
    created: new Date().toISOString(),
    syncDeletes: workspace.syncDeletes ?? config.defaults.syncDeletes
  }
  
  await saveConfig(config)
  return config.workspaces[name]
}

/**
 * Get a workspace by name
 * @param {string} name - Workspace alias
 * @returns {Object|null} Workspace details or null
 */
export async function getWorkspace(name) {
  const config = await loadConfig()
  return config.workspaces[name] || null
}

/**
 * Get workspace by path
 * @param {string} wsPath - Absolute path
 * @returns {Object|null} Workspace with name, or null
 */
export async function getWorkspaceByPath(wsPath) {
  const config = await loadConfig()
  
  for (const [name, ws] of Object.entries(config.workspaces)) {
    if (ws.path === wsPath) {
      return { name, ...ws }
    }
  }
  
  return null
}

/**
 * List all workspaces
 * @returns {Promise<Array>} Array of {name, ...workspace}
 */
export async function listWorkspaces() {
  const config = await loadConfig()
  
  return Object.entries(config.workspaces).map(([name, ws]) => ({
    name,
    ...ws
  }))
}

/**
 * Remove a workspace from config
 * @param {string} name - Workspace alias
 * @param {boolean} deleteData - Also delete hypercore data
 */
export async function removeWorkspace(name, deleteData = false) {
  const config = await loadConfig()
  
  const workspace = config.workspaces[name]
  if (!workspace) {
    throw new Error(`Workspace '${name}' not found`)
  }
  
  // Optionally delete hypercore data
  if (deleteData) {
    const storePath = getStorePath(workspace.key)
    try {
      await fs.rm(storePath, { recursive: true, force: true })
    } catch (err) {
      // Ignore if already deleted
    }
  }
  
  delete config.workspaces[name]
  await saveConfig(config)
}

/**
 * Update workspace settings
 * @param {string} name - Workspace alias
 * @param {Object} updates - Fields to update
 */
export async function updateWorkspace(name, updates) {
  const config = await loadConfig()
  
  if (!config.workspaces[name]) {
    throw new Error(`Workspace '${name}' not found`)
  }
  
  config.workspaces[name] = {
    ...config.workspaces[name],
    ...updates
  }
  
  await saveConfig(config)
  return config.workspaces[name]
}

/**
 * Validate key format
 * @param {string} key - Potential key
 * @returns {boolean} True if valid
 */
export function isValidKey(key) {
  return /^[a-f0-9]{64}$/i.test(key)
}

/**
 * Ensure data directories exist
 */
export async function ensureDataDirs() {
  await fs.mkdir(STORES_PATH, { recursive: true })
  await fs.mkdir(TRANSFERS_PATH, { recursive: true })
}
