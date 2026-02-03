# PearSync

P2P file sync - Dropbox but decentralized.

Drop a file in a folder, it syncs to all connected peers. Built on [Holepunch](https://holepunch.to) primitives (Hyperdrive, Hyperswarm).

## Features

- **No servers** - Direct peer-to-peer sync via DHT
- **No accounts** - The 64-byte key IS your authentication
- **Clean sync folders** - No hidden folders in your synced directory
- **Named workspaces** - Manage multiple sync folders easily
- **Cross-network** - Works across NATs via hole-punching

## Installation

```bash
npm install -g pearsync
```

Or clone and link:
```bash
git clone https://github.com/RMF-Agent-Network/pearsync.git
cd pearsync
npm install
npm link
```

## Quick Start

**Create a shared folder:**
```bash
pearsync init ~/shared --name robby-hal
# Outputs a key like: fbbf85f9baf3c4fcd211c1fd69d93e6c6b22463e8417b45c4940698fb8726073
```

**Join from another machine:**
```bash
pearsync join fbbf85f9... ~/shared --name robby-hal
```

**Start syncing:**
```bash
pearsync watch robby-hal
```

**Check status:**
```bash
pearsync list
pearsync status robby-hal
```

## Commands

| Command | Description |
|---------|-------------|
| `init <path> --name <alias>` | Create a new shared workspace |
| `join <key> <path> --name <alias>` | Join an existing workspace |
| `watch <name>` | Watch and sync continuously |
| `status [name]` | Show workspace info |
| `list` | List all workspaces |
| `remove <name>` | Remove workspace from config |

## Options

| Option | Description |
|--------|-------------|
| `--name <alias>` | Name for the workspace (required for init/join) |
| `--no-delete` | Don't sync deletions (keep local files) |
| `--delete-data` | Also delete hypercore data when removing |
| `--verbose` | Show detailed output |

## Storage

- **Config:** `~/.config/pearsync/config.json`
- **Data:** `~/.local/share/pearsync/stores/`

Your sync folders stay clean - all hypercore data is stored separately.

## Ignored Files

By default, these are ignored:
- `node_modules`, `.git`
- `.DS_Store`, `Thumbs.db`
- `*.swp`, `*.swo`, `*~`
- `.env`, `.env.local`

Create a `.pearsyncignore` file in your workspace for custom patterns.

## How It Works

1. **Init** creates a new Hyperdrive (P2P filesystem) and announces it to the DHT
2. **Join** connects to an existing Hyperdrive by key
3. **Watch** monitors for changes and syncs bidirectionally
4. Peers discover each other via [Hyperswarm](https://docs.holepunch.to/building-blocks/hyperswarm)
5. Files are stored as [Hypercores](https://docs.holepunch.to/building-blocks/hypercore) with Merkle tree verification

## Security

- The 64-byte hex key is your authentication - share carefully
- All connections use the Noise protocol (encrypted + authenticated)
- Data integrity verified via Merkle trees
- Anyone with the key has full read access

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                           PearSync                              │
├─────────────────────────────────────────────────────────────────┤
│  CLI (bin/pearsync.js)                                          │
│    ↓                                                            │
│  Config Manager (lib/config.js)                                 │
│    ↓                                                            │
│  Sync Engine (lib/sync.js)                                      │
│    ↓                                                            │
│  Hyperdrive ←→ Hyperswarm ←→ Localdrive                         │
│  (P2P FS)      (Discovery)    (Local FS)                        │
└─────────────────────────────────────────────────────────────────┘
```

## License

MIT
