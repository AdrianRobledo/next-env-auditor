# env-auditor

Scans a Next.js repo for:
- Missing env vars (compared to an env file)
- Unused env vars
- Risky env var patterns (heuristics)

## Install (local dev)
npm i
sudo npm link

## Usage
env-auditor /path/to/project /path/to/env.txt
env-auditor /path/to/project.zip /path/to/env.txt

### Without env file
env-auditor /path/to/project
