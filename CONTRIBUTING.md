# Contributing to Claude Persistent Memory

Thanks for your interest in contributing! This guide will help you get started.

## Development Setup

```bash
git clone https://github.com/MIMI180306/claude-persistent-memory.git
cd claude-persistent-memory
npm install
cp config.default.js config.js
# Edit config.js with your Azure OpenAI credentials
```

## How to Contribute

### Reporting Bugs

- Use the [Bug Report](https://github.com/MIMI180306/claude-persistent-memory/issues/new?template=bug_report.yml) template
- Include your Node.js version, OS, and steps to reproduce

### Suggesting Features

- Use the [Feature Request](https://github.com/MIMI180306/claude-persistent-memory/issues/new?template=feature_request.yml) template
- Explain the use case and expected behavior

### Submitting Code

1. **Fork** the repository
2. **Create a branch** from `main`: `git checkout -b feat/your-feature`
3. **Make your changes** and add tests if applicable
4. **Run linting**: `npm run lint` (if configured)
5. **Commit** with a clear message:
   - `feat: add memory export command`
   - `fix: correct vector similarity threshold`
   - `docs: update configuration guide`
6. **Push** to your fork and open a **Pull Request**

### Commit Message Convention

We follow [Conventional Commits](https://www.conventionalcommits.org/):

| Prefix | Purpose |
|--------|---------|
| `feat:` | New feature |
| `fix:` | Bug fix |
| `docs:` | Documentation only |
| `refactor:` | Code change that neither fixes a bug nor adds a feature |
| `test:` | Adding or updating tests |
| `chore:` | Maintenance tasks |

### Pull Request Guidelines

- Reference related issues (e.g., `Closes #12`)
- Keep PRs focused — one feature or fix per PR
- Update documentation if you change behavior
- Ensure CI passes before requesting review

## Project Structure

```
hooks/       → Claude Code lifecycle hooks
lib/         → Core libraries (DB, embedding, LLM clients)
services/    → Background TCP servers and MCP server
tools/       → Utility scripts
```

## Code Style

- Use ES module patterns consistent with existing code
- Keep functions small and focused
- Add JSDoc comments for public APIs

## Questions?

Open a [Discussion](https://github.com/MIMI180306/claude-persistent-memory/discussions) or an issue — happy to help!
