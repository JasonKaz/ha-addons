# Changelog

## 0.0.11

- `POST /acknowledge` now acknowledges only the recalls shown in the sensor's `recalls` attribute (up to 10), not every match, so recalls beyond that cap stay new until they've been shown
- `POST /acknowledge` accepts an optional `{"ids": [...]}` body to acknowledge specific recalls; each entry in the `recalls` attribute now includes its `id`
- The `/recalls` page's **Acknowledge All** button acknowledges exactly the recalls on the page, even if a scan finishes after the page loaded

## 0.0.10

- Sort unacknowledged recalls to the top of the `/recalls` page, matching the order of the sensor's `recalls` attribute

## 0.0.9

- Add support for running the addon directly in a docker container

## 0.0.8

- Truncate long lot/serial code lists so recall cards stay compact; the full list is behind a "Show all lot/serial codes" toggle on the `/recalls` page

## 0.0.7

- Add `aarch64` to build options

## 0.0.6

- Fix bug when recall number was "N/A", resulting in collisions
- Improve Google search query for API results

## 0.0.5

- Fix an issue where new API results would not appear before acknowledged page results

## 0.0.4

- Add `aarch64` to arch config

## 0.0.3

- Add url to config
- Add CHANGELOG.md

## 0.0.2

- Update docs to include sample usage

## 0.0.1

- Initial publish
