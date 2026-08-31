# FDA Recall Monitor (Home Assistant add-on)

Scans FDA recall data on a schedule and reports how many **new,
not-yet-acknowledged** recalls currently match your configured search
terms, via a `sensor.fda_recall_count` entity. Filter terms are matched
whole-word and case-sensitive (e.g. `WA` matches the state, not "wa"
inside "water"; `NY` won't match inside "COMPANY").

Every scan checks **two independent sources** and merges the results:
FDA's public recall listing page, and openFDA's food/drug/device
enforcement APIs. These two sources have been found to disagree in both
directions — recalls exist on the public page that never show up in the
API (sometimes for weeks), and recalls exist in the API that never get
posted to the public page at all — so relying on just one misses real
recalls the other one has.

The sensor is designed to be actionable: its state drops back to 0 once
you acknowledge the currently-shown recalls, and only rises again when a
genuinely new matching recall appears — see "Acknowledging recalls" below.

## Install (manual — this add-on isn't published anywhere, it's a local add-on)

1. Copy this whole `fda-recalls-addon/` folder to `/addons/local/fda-recalls-addon/`
   on the Home Assistant host. Reach the HAOS filesystem via:
   - the **Samba share** add-on, if installed (`\\<ha-host>\addons\local\`), or
   - the **Advanced SSH & Web Terminal** add-on's shell.
2. In the Home Assistant UI: **Settings → Add-ons → Add-on Store → ⋮ menu
   → Check for updates** (or restart the Supervisor) so it picks up the
   new local add-on.
3. Install **"FDA Recall Monitor"** from the "Local add-ons" section that
   appears.
4. Open its **Configuration** tab and set:
   - `filter` — comma-separated search terms, e.g. `Seattle,jalapeno`.
   - `scan_interval_minutes` — how often to re-scan (default 60).
   - `openfda_api_key` — optional. Get a free key at
     [open.fda.gov/apis/authentication](https://open.fda.gov/apis/authentication/)
     if you want one; it only raises the daily request ceiling (1,000/day
     per IP without a key → 120,000/day per key), which this add-on's
     normal usage never comes close to. Leave blank otherwise.
   - `cache_max_age_days` — optional, default `0` (disabled). The
     page-scraper's detail-page cache (`/data/fda-recalls-cache/`) never
     expires by default; set this to automatically prune cached pages
     older than the given number of days during each scan, so the cache
     doesn't grow indefinitely.
5. Save, then Start the add-on.
6. Confirm `sensor.fda_recall_count` appears under **Developer Tools →
   States**.

## Sensor attributes

- `state` — count of matching recalls not yet acknowledged.
- `total_matching_recalls` — count of every currently-matching recall,
  acknowledged or not.
- `last_acknowledged` — ISO timestamp of the last time you acknowledged
  recalls, or `null` if never.
- `last_checked` — ISO timestamp of the most recent scan.
- `filter_terms` — the search terms currently configured.
- `recalls` — up to 10 of the most recent matches (a quick-glance sample,
  not the full list — see "Full recall list" below for that), each with
  `date`, `brand`, `productDescription`, `recallReason`, `url`, `source`
  (`"page"` or `"api"`), `category` (`"food"`/`"drug"`/`"device"`,
  API-sourced entries only), `recallNumber`, `classification`
  (API-sourced entries only), and `isNew` (`true` until you acknowledge
  it). openFDA doesn't expose a reliable per-record public page, so
  API-sourced entries' `url` instead points at a Google search for
  `FDA recall <recallNumber>` — not guaranteed to surface the exact page,
  but usually does.

## Acknowledging recalls

The add-on exposes a small HTTP endpoint for acknowledging the
currently-shown recalls: `POST /acknowledge`. This marks every recall in
the most recent scan as seen, so `sensor.fda_recall_count` immediately
drops to 0 and only climbs again once a new, not-yet-seen recall is found.

There's no built-in dashboard button for this — wire it up with Home
Assistant's core `rest_command` integration. Since `rest_command` runs
from Home Assistant Core, which sits on the same internal network as this
add-on, use the add-on's own hostname (shown on its **Info** tab, e.g.
`local-fda-recall-monitor` — note underscores in the slug become hyphens)
together with its **internal** port, `8099`. That internal port doesn't
change even if you remap the host-side port for outside access, so no
Advanced Mode / Network-section lookup is needed for this:

```yaml
rest_command:
  fda_recall_acknowledge:
    url: "http://local-fda-recall-monitor:8099/acknowledge"
    method: POST
```

(Replace `local-fda-recall-monitor` with whatever hostname your own
Info tab shows, if it differs.) Then restart Home Assistant (or reload
`rest_command` entities) so it picks up the new service.

If you ever need to reach `/acknowledge` from _outside_ Home Assistant's
internal network (e.g. curling it from another device on your LAN), use
the Home Assistant host's IP and the host-side port instead — that
mapping is visible under this add-on's Info tab **Network** section, which
only appears once **Advanced Mode** is enabled on your user profile
(click your profile icon → toggle Advanced Mode).

**Security note:** this endpoint has no authentication of its own — it's
a plain HTTP port reachable by anything on your LAN that can reach the
Home Assistant host. That's an acceptable tradeoff for a LAN-only add-on
like this one, but worth knowing.

## Full recall list

The sensor's `recalls` attribute only carries 10 entries — Lovelace's
built-in cards (Markdown, Entities, etc.) can only read Home Assistant's
own state/attributes, so there's no way to hand one "everything" without
either bloating that attribute (which then risks tripping Home Assistant
recorder's ~16KB attribute-size warning and losing history for the
entity) or serving it from somewhere a card can point at instead.

Since this add-on already runs its own HTTP server, it serves a full,
unbounded HTML list at `GET /recalls`, with its own "Acknowledge All"
button (separate from, and doing the same thing as, the dashboard button
card below). Add it to a dashboard with Lovelace's built-in `iframe` card:

```yaml
type: iframe
url: "http://<home-assistant-host-ip>:<host-mapped-port>/recalls"
aspect_ratio: 75%
```

**This URL is different from the `/acknowledge` one above** — an
`iframe`'s content is loaded directly by your browser (on whatever device
you're viewing the dashboard from), not by Home Assistant Core itself, so
the add-on's internal-network hostname won't resolve here (you'll get a
DNS-style error like `NS_ERROR_UNKNOWN_HOST`). Use your Home Assistant
host's actual LAN IP address, and the host-side port this add-on's
`8099/tcp` is mapped to — both visible under this add-on's Info tab
**Network** section, which only appears once **Advanced Mode** is enabled
on your user profile (click your profile icon → toggle Advanced Mode).

## Example dashboard cards

Two ready-to-paste Lovelace cards — add these via a dashboard's "Edit
Dashboard" → "Add Card" → "Manual" (YAML mode):

**Display card** (Markdown card, built from the sensor's attributes):

```yaml
type: markdown
title: FDA Recalls
content: >
  **{{ states('sensor.fda_recall_count') }} new recall(s)** out of
  {{ state_attr('sensor.fda_recall_count', 'total_matching_recalls') }} total matching

  {% for r in state_attr('sensor.fda_recall_count', 'recalls') | selectattr('isNew') %}
  - **{{ r.brand }}** — {{ r.productDescription }}
    ({{ r.recallReason }}) {{ "[" + (r.recallNumber or "details") + "](" + r.url + ")" if r.url else "(" + (r.recallNumber or "no reference") + ")" }}
  {% endfor %}
```

Only recalls still marked `isNew` render in the list — once you
acknowledge, they drop out of the card immediately (the summary line still
shows the total match count for context). Page-sourced recalls link the
word "details"; API-sourced recalls link their `recallNumber` instead,
pointing at a Google search for that recall id (see "Sensor attributes"
above).

**Acknowledge button** (calls the `rest_command` set up above):

```yaml
type: button
name: Acknowledge Recalls
icon: mdi:check-circle
tap_action:
  action: call-service
  service: rest_command.fda_recall_acknowledge
```

## Development

```bash
npm install
npm test              # run the test suite
npm run test:coverage # run the test suite with coverage
npm run lint           # oxlint .
npm run format          # oxfmt . --write
```

A repo-wide pre-commit hook (`.githooks/pre-commit`) runs `format`, `lint`,
and the test suite for any add-on directory touched by the commit, and
blocks the commit if lint or a test fails. Since git hooks aren't installed
automatically from a fresh clone, enable it once per clone:

```bash
git config core.hooksPath .githooks
```

## Notes

- Detail pages scraped from the FDA site are cached under this add-on's
  persistent `/data` storage, so re-scans after the first one only
  re-fetch recalls not already seen — the listing page itself is always
  fetched fresh so new recalls show up. The openFDA API side isn't
  cached — it's a normal rate-limit-tolerant public API, queried fresh
  every scan.
- `cache_max_age_days` (see above) only prunes `/data/fda-recalls-cache/`
  — `/data/acknowledged.json` is a separate, unrelated concern and is
  never touched by pruning. Pruning happens before that scan looks up any
  detail pages, so if an expired entry's recall is still currently
  matching, it's simply re-fetched fresh in the same scan rather than
  left stale or silently dropped.
- If `filter` is left empty, the add-on logs a warning and reports 0
  rather than failing to start.
- Acknowledged recall ids are stored indefinitely in
  `/data/acknowledged.json` — this is a small flat list, not a concern at
  any realistic scale.
- **Upgrading from a version without the openFDA API source**: the
  acknowledge-tracking scheme changed from tracking recalls by `url` alone
  to a unified id (needed since API-sourced recalls have no `url`), and
  the field in `/data/acknowledged.json` was renamed accordingly. No
  action needed — the add-on just won't recognize the old file's field and
  will start with an empty acknowledged set — but it does mean anything
  you'd previously acknowledged will show up as new again once.
