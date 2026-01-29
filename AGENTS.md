# Agent Configuration

This is an npm package for pi coding agent - QMD extension.

## Package Structure

- `package.json` contains the `"pi"` field that declares extensions
- Extensions are in `./extensions/*.ts`
- Skills are in `./skills/*/`

## Installation

```bash
npm install -g pi-qmd
```

Then add to `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["pi-qmd"]
}
```

## Skills

### QMD Knowledge

Knowledge management skill for searching and retrieving documents from your QMD-indexed knowledge base.

**Slug:** `qmd-knowledge`
