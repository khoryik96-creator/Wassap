# wassap

Review the WhatsApp conversations that went unanswered — by date, how long they
have been waiting, whether the number is saved in your contacts, and whether you
or the other person owes the reply.

It links to your account the same way WhatsApp Web does (one QR scan), keeps a
local copy of your chats in SQLite, and reports on them from there.

```
19 unanswered conversations (of 24 analysed)
  awaiting them 12  ·  awaiting you 7
  saved 13  ·  unsaved 6  ·  groups 0  ·  longest wait 4mo 1d

 #  Contact        Number           Owed by         Last    Waiting  Msgs  Saved  Last message
--  -------------  ---------------  -------  -----------  ---------  ----  -----  -----------------
 1  ~Chris         +4915112345678   them          May 11     4mo 1d     1  no     Guten Tag, wir h…
 2  Tom Fletcher   +447700900333    you           Aug 12    2mo 11d     5  yes    still keen if yo…
 3  Priya Mehta    +447700900123    them          Sep 02     12d 9h     3  yes    did you get a ch…
```

## Read this first

This uses [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js),
which automates a real WhatsApp Web session. It is **not an official WhatsApp
API**, and automating your account is against WhatsApp's Terms of Service.
Accounts do occasionally get banned for automation. That risk is small for
read-only use at this volume, but it is not zero and it is yours to accept.

Nothing is uploaded anywhere. Your messages, the session, and every report stay
on your machine.

## Requirements

- Node.js 22.5 or newer (it uses the built-in `node:sqlite`)
- Chrome, Chromium or Edge — Puppeteer downloads its own during `npm install`,
  and an already-installed browser is used as a fallback

### If npm blocks Puppeteer's install script

Some npm configurations refuse postinstall scripts, which is how Puppeteer
fetches its Chromium. npm says so at the end of the install:

```
npm warn install-scripts   puppeteer@24.38.0 (postinstall: node install.mjs)
```

wassap falls back to a system Chrome, Chromium or Edge, so it will usually
still work. If it reports that no browser is available, either allow the
download or point it at a browser you have:

```bat
npm install-scripts approve puppeteer
npm install
```

```bat
set PUPPETEER_EXECUTABLE_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe
```

### If the QR code will not link

WhatsApp rotates the QR roughly every 20 seconds and only the newest one is
valid, so `login` redraws it each time. Scan the code at the **bottom** of your
terminal, not one that has scrolled up — scanning an expired code is what
produces "couldn't link device" on the phone.

Each code is also written to `~/.wassap/qr.png` (`C:\Users\<you>\.wassap\qr.png`
on Windows). If your terminal font makes the code hard for the camera to read,
open that image instead and scan it from the screen. It is rewritten on every
refresh, so reopen it after each redraw.

### About the npm audit warnings

`npm install` reports 5 high-severity advisories. They are one issue counted
five times: a path-traversal bug in `extract-zip`, which Puppeteer uses solely
to unpack a browser it downloads from Google. It is not reachable from anything
wassap does with your messages. There is no patched release upstream yet, so
`npm audit fix` reports the same five and changes nothing.

## Setup

```bash
npm install
node bin/wassap.js login    # scan the QR with WhatsApp > Linked devices
node bin/wassap.js sync     # pull your chats into the local database
node bin/wassap.js review   # see what is unanswered
```

Optionally `npm link` so it is just `wassap` from anywhere.

### Windows

Run the commands from the project folder, not from `C:\Windows\System32`.
In `cmd.exe`, environment variables are set on their own line with `set`
(`VAR=value command` is bash syntax and will not work):

```bat
cd /d %USERPROFILE%
git clone https://github.com/khoryik96-creator/Wassap.git
cd Wassap
npm install
node bin/wassap.js login
node bin/wassap.js sync
node bin/wassap.js review
```

In PowerShell the variable syntax is `$env:WASSAP_HOME = "..."` instead.

If accented characters or the table borders look like mojibake in `cmd.exe`,
switch the console to UTF-8 first with `chcp 65001`, or use Windows Terminal.

## Try it without linking an account

```bash
WASSAP_HOME=/tmp/wassap-demo node scripts/seed-demo.js
WASSAP_HOME=/tmp/wassap-demo node bin/wassap.js review
```

On Windows (`cmd.exe`):

```bat
set WASSAP_HOME=%TEMP%\wassap-demo
node scripts/seed-demo.js
node bin/wassap.js review
```

This fills a throwaway database with synthetic conversations so you can see the
output and the dashboard before deciding to link anything. Unset the variable
again (`set WASSAP_HOME=`) before working with your real account.

If you forget to set `WASSAP_HOME` first, the demo data lands in your real
store instead. Nothing is lost and nothing silently mixes: `status` flags the
database as demo data and `sync` refuses to run against it. Clear it with:

```bash
wassap reset --yes
```

## What counts as unanswered

A conversation is unanswered when nobody has replied to the most recent message
in it. Which side is waiting puts it in one of two buckets:

| Bucket | Meaning | Flag |
| --- | --- | --- |
| `awaiting them` | You sent last and got no reply | `--direction them` |
| `awaiting you` | They sent last and you never replied | `--direction you` |

Two durations are reported, because they answer different questions:

- **Waiting** — since the ball moved to the other side, i.e. the start of the
  run of consecutive messages from the same person. This is what `--min-wait`
  filters on and what the table sorts by.
- **Silence** — since the very last message.

They differ when you send several messages in a row. If you messaged someone on
the 1st, 4th and 9th with no reply, you have been *waiting* since the 1st but it
has only been *silent* since the 9th.

System events (encryption notices, group joins, call logs) never count as
messages, so they cannot make a dead thread look answered.

## Commands

| Command | What it does |
| --- | --- |
| `login` | Link to your account by QR code |
| `sync` | Pull chats and recent messages into the local database |
| `review` | Report unanswered conversations (the default command) |
| `status` | Show what is stored and when it was last synced |
| `reset` | Delete the local message database (needs `--yes`) |
| `logout` | Unlink and delete the stored session |

## Filters

| Flag | Effect |
| --- | --- |
| `--direction <both\|them\|you>` | Which side is owed a reply. Default `both` |
| `--since <date\|duration>` | Last message newer than this (`30d`, `2026-01-15`) |
| `--until <date\|duration>` | Last message older than this |
| `--min-wait <duration>` | Pending at least this long (`3d`, `12h`, `1d12h`) |
| `--max-wait <duration>` | Pending at most this long |
| `--saved` / `--unsaved` | Only numbers in / not in your contacts |
| `--chat-type <direct\|group\|all>` | Default `direct` |
| `--groups` / `--only-groups` | Shorthands for `all` / `group` |
| `--archived` | Include archived chats (excluded by default) |
| `--exclude-muted` | Skip muted chats |
| `--blocked` | Include blocked contacts |
| `--search <text>` | Match a name, number or push name |
| `--min-messages <n>` | Ignore threads thinner than this |
| `--unread` | Only chats with unread messages |
| `--sort <key>` | `waiting`, `silence`, `date`, `oldest`, `name`, `count`, `messages`, `unread` |
| `--limit <n>` | Cap the number of rows shown |

Durations accept `s m h d w mo y` and combine (`1d12h`, `2w 3d`). A bare number
means days. Dates are anything `Date.parse` understands.

Saved and unsaved describe a person's number, so `--saved` and `--unsaved`
exclude group chats entirely rather than filing them under unsaved.

## Output

```bash
wassap review                                  # terminal table
wassap review --json                           # JSON to stdout
wassap review --csv  --out unanswered.csv      # CSV to a file
wassap review --html                           # dashboard at ./report.html
wassap review --html --out ~/Desktop/w.html    # dashboard somewhere else
```

The HTML dashboard is a single self-contained file with no network requests. It
re-filters and re-sorts in the browser, so you can hand it a broad export and
narrow down interactively. It follows your system light/dark setting.

Because JSON and CSV go to stdout by default, they pipe:

```bash
wassap review --unsaved --min-wait 7d --json | jq -r '.threads[].number'
```

## Examples

```bash
# People who never replied to me, quiet for over three days
wassap review --direction them --min-wait 3d

# Unsaved numbers I have left hanging — likely enquiries or leads
wassap review --direction you --unsaved

# Everything that went quiet in a particular window
wassap review --since 2026-01-01 --until 2026-03-31

# Long-dormant threads with real history behind them, not one-off pings
wassap review --min-wait 1mo --min-messages 10 --sort oldest

# Groups where the last word was mine
wassap review --only-groups --direction them
```

## Keeping it current

`sync` is additive — it updates what changed and keeps everything it has seen
before, so your local history grows past what any single fetch returns. Running
it on a schedule keeps reports fresh:

```cron
0 8 * * * cd /path/to/wassap && /usr/bin/node bin/wassap.js sync >> ~/.wassap/sync.log 2>&1
```

By default `sync` fetches the most recent 50 messages per chat. Raise it with
`--messages 200` for a deeper first pass; skip groups with `--no-groups`.

## Where your data lives

Everything sits under `~/.wassap` (override with `WASSAP_HOME`):

```
~/.wassap/
  wassap.db     chats and messages
  session/      the linked-device credentials
```

`wassap logout` deletes the session. To remove the message archive too, delete
the directory. Generated reports contain message previews — treat them as you
would the conversations themselves.

## Limitations

- Message history is whatever WhatsApp Web exposes to a linked device. A brand
  new link does not backfill years of history; the local archive fills in as you
  keep syncing.
- Contact names come from your address book as WhatsApp sees it. Unsaved numbers
  show the sender's self-set push name prefixed with `~`, or just the number.
- Numbers are shown as `+` plus digits rather than in national formatting.
- Read-only. It never sends, marks as read, or otherwise changes anything.

## Development

```bash
npm test    # 55 tests, no network or account needed
```

Tests cover the unanswered-thread engine, every filter, the report formats and a
round trip through SQLite. `src/analyze.js` holds the logic worth reading first.
