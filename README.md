# pi-qmd

[QMD](https://github.com/tobi/qmd) (Quick Markdown Search) extension for [pi coding agent](https://github.com/badlogic/pi-mono) - on-device knowledge base search with BM25, vector search, and LLM reranking.

![QMD Browser](https://github.com/hjanuschka/pi-qmd/raw/main/screenshot.png)

## Features

- **Full TUI Browser** (`/qmd_ui`) - Split-pane interface with results tree and markdown preview
- **Multiple Search Modes** - Keyword (BM25), Semantic (vector), and Hybrid (LLM reranking)
- **Smart Preview** - Auto-loads and scrolls to matched section with highlighting
- **6 Tools** for LLM-driven search and retrieval

## Installation

### Prerequisites

QMD requires [Bun](https://bun.sh) runtime:

```bash
# Install Bun and QMD
brew install oven-sh/bun/bun
bun install -g https://github.com/tobi/qmd
```

### Install Extension

```bash
npm install -g pi-qmd
```

Add to `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["pi-qmd"]
}
```

## Usage

### Commands

| Command | Description |
|---------|-------------|
| `/qmd [query]` | Quick search |
| `/qmd status` | Show index status |
| `/qmd_ui [query]` | Open full TUI browser |
| `/qmd collections` | List collections |
| `/qmd add <path>` | Add a collection |
| `/qmd embed` | Generate embeddings |

### TUI Browser (`/qmd_ui`)

```
╭─────────────────────────────────────────────────────────────────╮
│ 📚 QMD Browser (Keyword)                                        │
├─────────────────────────────────────────────────────────────────┤
│ Search:                                                         │
│ > oauth                                                         │
│ Found 5 results                                                 │
├─────────────────────────────────────────────────────────────────┤
│ Results                          │ Preview                      │
│ 📁 Meeting notes                 │ # Sprint Planning            │
│ ├→ Sprint Planning 100%          │                              │
│ └─ 1:1 Meeting 95%               │ **Attendees:** Alice, Bob    │
│ 📁 Documentation                 │ **Duration:** 1 hour         │
│ └─ Auth API 90%                  │                              │
│                                  │ ## Sprint Goals              │
│                                  │ - Migrate to OAuth 2.0       │
├─────────────────────────────────────────────────────────────────┤
│ Enter search • Tab mode • ↑↓ navigate • Enter load • Esc close  │
╰─────────────────────────────────────────────────────────────────╯
```

**Controls:**
- **Enter** - Search (in input) / Load document (in results)
- **Tab** - Cycle search mode (Keyword → Semantic → Hybrid)
- **↑/↓** - Navigate results (auto-loads preview)
- **PgUp/PgDn** - Scroll preview
- **Esc** - Close

### Tools (for LLM)

| Tool | Description |
|------|-------------|
| `qmd_search` | Fast BM25 keyword search |
| `qmd_vsearch` | Semantic vector search |
| `qmd_query` | Hybrid search with LLM reranking |
| `qmd_get` | Retrieve document by path or docid |
| `qmd_multi_get` | Retrieve multiple docs by glob pattern |
| `qmd_status` | Check index health |

## Setting Up Your Knowledge Base

```bash
# Index a folder
qmd collection add ~/notes --name notes

# Generate embeddings for semantic search
qmd embed

# Verify
qmd status
```

## Skill

The package includes a skill at `skills/qmd-knowledge/SKILL.md` that teaches the LLM how to effectively search your knowledge base. Symlink it:

```bash
ln -s $(npm root -g)/pi-qmd/skills/qmd-knowledge ~/.pi/agent/skills/
```

## License

MIT
