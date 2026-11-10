# Contributing to LTET Conversational AI Engine

Thank you for considering contributing to the LTET Conversational AI Engine! This document provides guidelines for contributing to the project.

## 📋 Before You Start

1. Read the [README.md](README.md) for project overview
2. Review the [Architecture](docs/ARCHITECTURE.md) to understand the system design
3. Check [Open Decisions](docs/OPEN_DECISIONS.md) for pending design decisions
4. Review [Security Decisions](docs/SECURITY_DECISIONS.md) for security constraints

## 🔧 Development Setup

```bash
# Clone and install
git clone https://github.com/Siddhant-Pardeshi-Doastra/ltet-conversational-ai-engine.git
cd ltet-conversational-ai-engine
npm install

# Seed the workspace dataset
npm run seed

# Start development
npm run dev
```

## ✅ Before Submitting

- [ ] Run `npm run lint` — all files must pass syntax check
- [ ] Run `npm test` — all 88 tests must pass
- [ ] Run `npm run seed -- --force` to verify seed reproducibility
- [ ] No `.env`, `data/`, or `node_modules/` files included in commit
- [ ] Sensitive data (OTPs, credentials) never appears in logs, transcripts, or test output

## 🔀 Pull Request Process

1. Create a feature branch from `main`
2. Make your changes with clear, descriptive commit messages
3. Ensure all tests pass and linting is clean
4. Update documentation if your change affects behavior
5. Open a PR with a clear description of *what* and *why*

## 📝 Commit Convention

```
feat: add new claim type support
fix: correct OTP replay protection edge case
docs: update architecture diagram
test: add beneficiary boundary test
refactor: simplify conversation state machine
```

## ⚠️ Important Constraints

- **Never bypass security boundaries** — OTP verification, RBAC, and audit trails are not optional
- **Never hardcode data** — all portal data comes from the data service and is validated before use
- **Demo vs Live mode** — demo tools must be impossible in live mode (tested in the live-mode suite)
- **Immutability** — call logs are immutable by design; never add UPDATE/DELETE paths to call records

## 🐛 Reporting Issues

Open a GitHub Issue with:
- Clear title describing the problem
- Steps to reproduce
- Expected vs actual behavior
- Node.js version and OS

## 📫 Questions?

Check the [AI_DEMO_RUNBOOK.txt](AI_DEMO_RUNBOOK.txt) for operational guidance, or open a discussion.
