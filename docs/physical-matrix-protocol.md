# Physical matrix — control protocol

Reverse-engineered from screenshots of the matrix's own "Central Control"
config tool, which has a Type/Control/parameter form that generates the
raw command bytes for each combination ("Code" field) — presumably so an
installer can copy them into a 3rd-party control system (Crestron/AMX/etc.)
without needing a full protocol doc. This page works backward from ~14
distinct example frames to the general grammar. Nothing here has been
confirmed against an actual vendor protocol document — everything is
inferred from the examples (and, for Mute and the transport, cross-checked
against a real working client — see "Existing client code" below), so treat
the still-"inferred" rows with appropriate suspicion until tested further.

## Existing client code: `2NBC_MatrixMixer`

There's already a small VB.NET WinForms app for this exact unit:
[github.com/vk2tds/2NBC_MatrixMixer](https://github.com/vk2tds/2NBC_MatrixMixer)
(`MatrixControl/Form1.vb`). It's not a general matrix GUI — it's a
purpose-built timer/preset tool for one venue: buttons for "Mute 1/2/3",
"Mute Raduga", and 60/120-minute auto-revert timers that switch between a
few hardcoded mute presets (`connectionsNormal`, `connectionsRaduga`,
`connectionsMuteMix1/2/3`). But it settles two of the biggest open questions
below by actually doing them over the wire:

- **Transport confirmed: raw TCP socket, no wrapper.**
  `New TcpClient(My.Settings.MixerIP, My.Settings.MixerPort)`, then
  `stream.Write` of the exact frame bytes directly — no HTTP, no
  session/login handshake. Configured (`App.config`) as
  **`192.168.32.188:8234`** — same IP as the Device Manage dialog, and a
  real port number rather than the `8899` guess this doc previously made.
- **Mute Set frame confirmed** (`updateMatrixMute`, `Form1.vb:196`): `[I/O
  selector, channel, mute-bit]`, `N=3` — see the updated Mute section below.
- **A bug found in the process**: `updateMatrixRoute` (`Form1.vb:150`),
  the function that would actually drive Matrix Mixer crosspoint changes,
  ends its frame with `&HFF` instead of `&HEE` — inconsistent with every
  Matrix Mixer example captured from the vendor's own tool, and with every
  other frame this same app itself sends. It also turns out to be **dead
  code** — its only call site is commented out (`Form1.vb:277`,
  `'updateMatrixRoute(stream, item)`), so this has never actually been
  exercised against the hardware. Anyone building on this: fix the
  terminator before relying on it, and treat crosspoint routing over TCP as
  untested even though Mute is now confirmed working.

## Device identification

From the control app's Device Manage dialog and Device List panel:

| Field | Value |
|---|---|
| Device Name / ID | `D521881` |
| Device Group (nickname) | `Ben&fellow` |
| Software version | 2.4.38 (2019-12-13) |
| Firmware version | 3.1.9 (2020-04-23) |
| Hardware version | 0.0.0.0 *(unset/unused by this unit)* |
| IP | `192.168.32.188` |
| Gateway | `192.168.32.1` |
| MAC | `9C-A5-25-A6-C8-73` |

**Confirmed: Guangzhou DSPPA Audio Co., model DP8004** — "8-channel
Conference Audio Processor with 4x4 Dante"
([product page](https://www.dsppatech.com/product/dp8004-8channels-conference-audio-processor-with-4x4-dante.html),
[datasheet PDF](https://www.dsppatech.com/uploads/file/20210422/11/data-sheetdp8004-8-channels-conference.pdf) —
image-based, no protocol detail in it). 8 in/8 out total, with 4 of each
side being Dante (matches inputs A–D showing Dante source, E–H showing
Analog, in the signal-chain screenshot above) and built-in feedback
suppression, auto-mix, matrix mix, EQ, crossover, and compressor — matches
every control we've reverse-engineered below. `D521881` is this specific
unit's serial/device ID, not the model number.

Confirmed control interfaces (from the product page): **RS232** (Phoenix
connector), **RS485** (Phoenix connector), **TCP/IP** (RJ-45), **USB**
(Micro-B, driver-free), and a **GPIO** Phoenix connector ("Machine Archive,
customizable"). No public protocol document was found for the DP8004
specifically after searching — DSPPA's own download page doesn't list the
DP processor line at all, only their PA/intercom products. If official
protocol documentation is wanted, DSPPA's export contact is
export@dsppa.com / +86 20-37166520.

The MAC's OUI (`9C-A5-25`) is registered to **Shandong USR IOT Technology
Limited** — a maker of serial-to-Ethernet bridge modules, consistent with
how the DP8004 exposes its RJ-45 TCP/IP port (see "Transport layer" —
TCP is now confirmed working, not just plausible).

**Practically relevant:** this Mac already has an interface on the
`192.168.32.0/24` subnet (confirmed — `radio-audio-fingerprint`'s web app
bound to `192.168.32.142` earlier in this session), so a future GUI running
on this same machine can reach `192.168.32.188` directly, no new network
segment needed.

## Signal chain (from the main app's routing view)

Per-input chain: **AFC** (acoustic feedback cancellation — matches the
`08 Feedback` control below) → **Noise Gate** → **PEQ-X** (parametric EQ) →
**Delay** → feeds into **Auto Mix** logic and the **Matrix Mix** crosspoint
grid. Per-output chain, after Matrix Mix: **PEQ-X** → **Delay** →
**COMP** (compressor) → **Limit** → output.

8 inputs (`IN A`–`IN H`), 8 outputs (`OUT 1`–`OUT 8`) — matches the channel
range already inferred from Mute's channel dropdown (ALL, 1–8) and Matrix
Mixer's observed input/output channel numbers.

Inputs A–D show source **Dante** (module version `7.3`); inputs E–H show
source **Analog** (`7.6`/`3.0` — meaning unclear, possibly a sub-module
firmware version rather than a level). This refines the `0D Input Mode`
control documented below: it's very likely a per-channel Analog-vs-Dante
source select, with `Analog = 00` confirmed and the Dante-side value still
unknown (see "Open questions").

Matches the confirmed DP8004's 4x4 Dante + 4x4 analog split exactly.

## Frame grammar

```
A5 C3 3C 5A | FF | TYPE | CONTROL | N | <N data bytes> | EE
```

| Field | Size | Values seen | Notes |
|---|---|---|---|
| Preamble | 4 bytes | `A5 C3 3C 5A` | Constant across every example (Read and Set alike). Likely a fixed sync/magic-number header. |
| Address | 1 byte | `FF` | Constant across every example captured so far — never varies. Could be a fixed device-address byte (`FF` = broadcast/"any unit"), which would matter if this turns out to be a multi-drop bus (RS485) with several addressable units. Only one value ever observed, so this is unconfirmed either way. |
| Type | 1 byte | `63` = Read, `36` = Set | The only two values seen. No third value (e.g. a device→host *response* opcode) has been observed — see "Open questions". |
| Control | 1 byte | see table below | Selects what's being addressed (Scene, Mute, Gain, …). |
| N | 1 byte | `00`–`03` | Count of the data bytes that immediately follow, before the terminator. Confirmed consistent across every single example (see table) — this looks like a genuine length-prefixed frame, not a per-control fixed constant. |
| Data | N bytes | control-specific | See per-control tables below. |
| Terminator | 1 byte | `EE` | Constant, always the last byte. |

No checksum/CRC byte appears anywhere in these examples — the frame goes
straight from the last data byte to `EE`. Worth confirming this is genuinely
checksum-less on the wire, or whether this config tool's "Code" preview is a
simplified logical view and the real transport adds a checksum before `EE`
(see "Open questions").

## Control IDs

| Control byte | Name | Read example seen | Set example seen |
|---|---|---|---|
| `02` | Scene | ✅ | ✅ |
| `03` | Mute | ✅ | — |
| `04` | Gain | ✅ | — |
| `05` | Increase/Decreases *(inferred — see below)* | — | — |
| `06` | Line/Mic | ✅ | ✅ |
| `07` | 48V (phantom power) | ✅ | — |
| `08` | Feedback (suppression level) | — | ✅ |
| `09` | Matrix Mixer (crosspoint routing) | — | ✅ |
| `0A`–`0C` | **unknown — gap, see "Open questions"** | — | — |
| `0D` | Input Mode | — | ✅ |

The `05` = "Increase/Decreases" mapping is inferred purely from dropdown
*position* (it sits between Gain and Line/Mic in the Control list, seen in
a screenshot with that dropdown open) and the fact that `04` (Gain) and
`06` (Line/Mic) sandwich it numerically. No example frame for it was
captured, so treat this one value as unconfirmed until an actual Set/Read
example is seen — see "Open questions" below.

## Per-control data layout

Each row below is one directly-observed example, byte-for-byte.

### Scene (`02`)

| Type | Data bytes | Meaning |
|---|---|---|
| Read | *(N=0, none)* | Query current scene — no parameters needed. |
| Set | `01` | Recall scene number 1. `N=1`, single byte = scene number. |

Full frames:
- Read: `A5 C3 3C 5A FF 63 02 00 EE`
- Set scene 1: `A5 C3 3C 5A FF 36 02 01 01 EE`

### Mute (`03`)

| Type | Data bytes | Meaning |
|---|---|---|
| Read | `01 01` | Input(`01`), channel 1 |
| Read | `02 00` | Output(`02`), channel **ALL** (`00`) |
| Read | `02 03` | Output(`02`), channel 3 |

`N=2` for every Mute example: `[I/O selector, channel]`. I/O selector:
`01`=Input, `02`=Output. Channel: `00`=ALL, otherwise the channel number
directly (UI's channel dropdown shows ALL, 1–8 — an 8-channel matrix per
side, at least for this control).

**Set confirmed** by `2NBC_MatrixMixer`'s `updateMatrixMute` (see "Existing
client code" above), which has actually driven this against the real unit:
`N=3`, data = `[I/O selector, channel, mute-bit]` — same `01`=Input/`02`=Output
selector as Read, plus a third byte: `00`=unmuted, `01`=muted. Example
(channel 1, either side): `A5 C3 3C 5A FF 36 03 03 01 01 01 EE`. That
client only ever targets specific channels 1–8, never `00`=ALL, on Set —
whether `ALL` is accepted for Set is still unconfirmed.

Full frames:
- Read input ch1: `A5 C3 3C 5A FF 63 03 02 01 01 EE`
- Read output ALL: `A5 C3 3C 5A FF 63 03 02 02 00 EE`
- Read output ch3: `A5 C3 3C 5A FF 63 03 02 02 03 EE`
- Set input ch1 muted: `A5 C3 3C 5A FF 36 03 03 01 01 01 EE`

### Gain (`04`)

| Type | Data bytes | Meaning |
|---|---|---|
| Read | `01 01` | Input(`01`), channel 1 |

Read has the same two-byte `[I/O, channel]` shape as Mute's Read.

**Set confirmed**, and fully decoded: `N=4`, data = `[I/O selector, channel,
value-lo, value-hi]` — the value is a **signed 16-bit little-endian
integer, in tenths of a dB** (divide by 10 for the displayed gain). Verified
against six examples spanning −60.0 dB to +20.0 dB, all exact:

| Gain | Value bytes (lo, hi) | Decoded |
|---|---|---|
| +10.0 dB | `64 00` | 100 → 10.0 |
| 0.0 dB | `00 00` | 0 → 0.0 |
| −10.0 dB | `9C FF` | −100 → −10.0 |
| −60.0 dB | `A8 FD` | −600 → −60.0 |
| +20.0 dB | `C8 00` | 200 → 20.0 |
| +15.0 dB (input ch5) | `96 00` | 150 → 15.0 |

Full frames:
- Read: `A5 C3 3C 5A FF 63 04 02 01 01 EE`
- Set input ch1 → +10.0 dB: `A5 C3 3C 5A FF 36 04 04 01 01 64 00 EE`
- Set input ch1 → 0.0 dB: `A5 C3 3C 5A FF 36 04 04 01 01 00 00 EE`
- Set input ch1 → −10.0 dB: `A5 C3 3C 5A FF 36 04 04 01 01 9C FF EE`
- Set input ch1 → −60.0 dB: `A5 C3 3C 5A FF 36 04 04 01 01 A8 FD EE`
- Set input ch1 → +20.0 dB: `A5 C3 3C 5A FF 36 04 04 01 01 C8 00 EE`
- Set input ch5 → +15.0 dB: `A5 C3 3C 5A FF 36 04 04 01 05 96 00 EE`
- Set output ch5 → 0.0 dB: `A5 C3 3C 5A FF 36 04 04 02 05 00 00 EE`
- Set output ch4 → 0.0 dB: `A5 C3 3C 5A FF 36 04 04 02 04 00 00 EE`

### Line/Mic (`06`)

| Type | Data bytes | Meaning |
|---|---|---|
| Read | `01` | Channel 1 — no I/O selector (Line/Mic only ever applies to inputs, so the UI doesn't show an Input/Output field for it). |
| Set | `01 00` | Channel 1 → Mic (`00`) |
| Set | `01 01` | Channel 1 → Line (`01`) |

Full frames:
- Read: `A5 C3 3C 5A FF 63 06 01 01 EE`
- Set Mic: `A5 C3 3C 5A FF 36 06 02 01 00 EE`
- Set Line: `A5 C3 3C 5A FF 36 06 02 01 01 EE`

### 48V phantom power (`07`)

| Type | Data bytes | Meaning |
|---|---|---|
| Read | `01` | Channel 1 |

Same single-byte channel-only shape as Line/Mic (also input-only). No Set
example captured, but by strong analogy with Line/Mic and Matrix Mixer it's
almost certainly `[channel, 00/01]` for off/on.

Full frame: `A5 C3 3C 5A FF 63 07 01 01 EE`

### Feedback suppression (`08`)

| Type | Data bytes | Meaning |
|---|---|---|
| Set | `01 00` | Channel 1, Level = OFF (`00`) |

Only `Level=OFF` was captured — the Level dropdown almost certainly has more
values (some kind of suppression aggressiveness — Low/Med/High, or numeric
steps) that aren't recorded here. No Read example either.

Full frame: `A5 C3 3C 5A FF 36 08 02 01 00 EE`

### Matrix Mixer (`09`) — crosspoint routing

| Type | Data bytes | Meaning |
|---|---|---|
| Set | `01 01 00` | Input 1 → Output 1, OFF |
| Set | `04 06 00` | Input 4 → Output 6, OFF |
| Set | `04 06 01` | Input 4 → Output 6, ON |

`N=3`: `[input channel, output channel, on/off]`. `00`=off/disconnect,
`01`=on/connect — this is the actual crosspoint toggle, i.e. the core "build
a GUI for the physical matrix" feature depends on this control. No Read
example captured — unknown whether reading a crosspoint's state needs
`[input, output]` (2 bytes) mirroring the Set shape.

**Caution**: `2NBC_MatrixMixer`'s attempt at this (`updateMatrixRoute`,
see "Existing client code" above) ends the frame with `&HFF` instead of
`&HEE`, and has never actually been sent to the hardware (dead code, its
call site is commented out) — so unlike Mute, this control has zero
real-world confirmation behind it yet. Use the `EE`-terminated frames below
(straight from the vendor's own tool), not that app's version.

Full frames:
- `A5 C3 3C 5A FF 36 09 03 01 01 00 EE`
- `A5 C3 3C 5A FF 36 09 03 04 06 00 EE`
- `A5 C3 3C 5A FF 36 09 03 04 06 01 EE`

### Input Mode (`0D`)

| Type | Data bytes | Meaning |
|---|---|---|
| Set | `03 00` | Channel 3 → Mode = Analog (`00`) |

Only `Mode=Analog` captured. Other mode values (digital/AES3? network input?
— unknown what alternatives this unit actually has) aren't recorded.

Full frame: `A5 C3 3C 5A FF 36 0D 02 03 00 EE`

## Open questions / holes

Ranked roughly by how much they block actually building the GUI:

1. ~~Gain Set is completely uncaptured~~ — **resolved**: `N=4`,
   `[I/O, channel, value-lo, value-hi]`, signed 16-bit little-endian tenths
   of a dB. See the Gain section above. Note for other controls still
   using a single `00`/`01` byte today (Feedback Level, Increase/Decreases)
   — worth checking whether they're actually multi-byte signed values too
   once real examples turn up, now that we know this device uses that
   encoding at least for Gain.
2. ~~Mute Set is uncaptured~~ — **resolved**: confirmed via
   `2NBC_MatrixMixer`'s working `updateMatrixMute`, see the Mute section
   above.
3. **Matrix Mixer Set is unverified against real hardware.** The frame shape
   is confirmed from the vendor's own tool, but the only client code that's
   tried to send it has a terminator bug and was never actually run (see
   "Existing client code") — so, unlike Mute, nobody has confirmed this
   control actually works over the wire yet. Worth an early, low-stakes test
   once building against it.
4. **Control IDs `0A`–`0C` are a complete gap.** Between Matrix Mixer (`09`)
   and Input Mode (`0D`) there are three unused byte values with no
   corresponding control shown in any screenshot or dropdown. Either
   reserved, or there are 1–3 more controls this "Central Control" dialog's
   dropdown didn't show in the captured screenshot (worth re-opening that
   dropdown and checking if it scrolls further).
5. **No response/reply frame has been observed at all.** `2NBC_MatrixMixer`
   reads `stream.DataAvailable` after each write and logs whatever comes
   back as raw hex/ASCII, but never parses it — so even though it's a
   working client, it doesn't tell us the reply format either. Still
   unknown: reply framing, whether replies reuse Type `63` or use a
   distinct opcode, how the actual value comes back for Scene/Mute/Gain
   reads.
6. **No checksum/CRC visible** — confirm whether the wire protocol really
   omits one, or whether this config tool's Code field is simplified.
   `2NBC_MatrixMixer` sends frames with no checksum and (per its logging)
   gets a response, which is a point in favor of "genuinely checksum-less."
7. **Address byte (`FF`) meaning unconfirmed.** Always `FF` in every capture
   — never seen varying, so we can't tell if it's a fixed constant or a
   device address that matters once one goes to a bus with multiple
   addressable units. Relevant if RS232/RS485 is ever used instead of the
   now-confirmed TCP path.
8. **Feedback "Level" range** — only `OFF (00)` seen; other levels unknown.
9. **Input Mode "Mode" range** — only `Analog (00)` seen; other modes
   unknown.
10. **Scene number range** — only `01` seen; max scene count unconfirmed.
11. **Matrix size** — inputs/outputs seen only as 1, 3, 4, 6 (Matrix Mixer)
    and up to 8 (Mute's channel dropdown). Actual full I/O count of the
    physical unit not yet confirmed against these numbers.
12. **`Increase/Decreases` control (`05`, inferred)** — no example frame at
    all, value inferred purely from its position in the Control dropdown
    list between Gain and Line/Mic. Likely a relative nudge (vs. Gain's
    presumed absolute set) but completely unconfirmed.
13. **`ALL` channel encoding (`00`) only confirmed for Mute/Output.** Unknown
    whether `ALL` is valid for Gain, Line/Mic, 48V, etc., or specific to Mute.

## Transport layer

**Confirmed via `2NBC_MatrixMixer`** (see "Existing client code" above):
plain **TCP, `192.168.32.188:8234`**, raw socket — `TcpClient` connect,
`stream.Write` the frame bytes directly, no HTTP wrapper, no login/session
handshake. That guess of port `8899` (USR IOT's common default) in an
earlier version of this doc was wrong; `8234` is what's actually configured
and, per that app's commit history ("Fix Network Exceptions" etc.), has
been used against the real hardware.

Remaining transport-level unknowns, now secondary since TCP is the
practical path forward (this Mac is already on `192.168.32.0/24`):

- Whether the device needs a fresh `TcpClient` connection per command (what
  `2NBC_MatrixMixer` does — connect, send, close) or tolerates/prefers a
  held-open connection for multiple commands in a row — not tested either
  way.
- RS232/RS485 baud rate, data/stop bits, and parity, and what the constant
  `FF` address byte would mean on a multi-drop RS485 bus — all still
  unknown, but low priority now that TCP is confirmed working.
