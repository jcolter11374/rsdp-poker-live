# Transparency

Written by the Transparency watcher workflow on main: right after every successful deploy, and on a schedule set to every hour that GitHub starts hours late (every few hours in practice). See docs/FAIRNESS.md.

- audit/: a copy of the public record from https://rsdp-poker-live.fly.dev/api/audit/entries
- deploys/: what the live machine ran, whether GitHub built and signed it, its settings and secrets (as fingerprints), and every start
