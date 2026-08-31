# ha-addons

Home Assistant add-ons, one per top-level directory. Each add-on is
self-contained: its own `package.json`, `Dockerfile`, `config.yaml`, and
README with install/usage instructions.

- [fda-recall-monitor](fda-recall-monitor/README.md)

## Development

A repo-wide pre-commit hook (`.githooks/pre-commit`) runs `format`, `lint`,
and the test suite for any add-on directory touched by a commit, and blocks
the commit if lint or a test fails. Since git hooks aren't installed
automatically from a fresh clone, enable it once per clone:

```bash
git config core.hooksPath .githooks
```
