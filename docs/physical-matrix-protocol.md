# Physical matrix — serial control protocol

Reverse-engineered from screenshots of the matrix's own "Central Control"
config tool, which has a Type/Control/parameter form that generates the
raw command bytes for each combination ("Code" field) — presumably so an
installer can copy them into a 3rd-party control system (Crestron/AMX/etc.)
without needing a full protocol doc. This page works backward from ~14
distinct example frames to the general grammar, so it can be implemented
against directly once the transport layer (serial port, baud rate, framing —
see "Open questions" below) is known. Nothing here has been confirmed against
an actual vendor protocol document — everything is inferred from the
examples, so treat the "inferred" rows with appropriate suspicion until
tested against real hardware.

**Make/model of the physical matrix not yet recorded here** — worth adding
once confirmed, so this doc (and any future vendor PDF) can be cross-checked.

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
*position* (it sits between Gain and Line/Mic in the Control list — see
`open_questions.md`-worthy screenshot with the dropdown open) and the fact
that `04` (Gain) and `06` (Line/Mic) sandwich it numerically. No example frame
for it was captured, so treat this one value as unconfirmed until an actual
Set/Read example is seen.

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

No Mute **Set** example was captured — only Read. The Set frame almost
certainly adds a third data byte (mute on/off, `00`/`01` by analogy with
every other boolean control below), making it `N=3`, but that's inferred,
not observed.

Full frames:
- Read input ch1: `A5 C3 3C 5A FF 63 03 02 01 01 EE`
- Read output ALL: `A5 C3 3C 5A FF 63 03 02 02 00 EE`
- Read output ch3: `A5 C3 3C 5A FF 63 03 02 02 03 EE`

### Gain (`04`)

| Type | Data bytes | Meaning |
|---|---|---|
| Read | `01 01` | Input(`01`), channel 1 |

Same two-byte `[I/O, channel]` shape as Mute's Read. **No Gain Set example
captured at all** — this is a significant gap (see "Open questions"): the
value encoding for an actual gain level (range, units, signed dB?) is
completely unknown.

Full frame: `A5 C3 3C 5A FF 63 04 02 01 01 EE`

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

1. **Gain Set is completely uncaptured.** We have Gain *Read*'s query shape
   (`[I/O, channel]`) but zero information about the Set frame: does it add
   a third byte? What's the value encoding — raw dB, a 0–100/0–127 range, a
   signed byte for negative gain? This blocks the single most basic mixer
   operation (adjusting a fader).
2. **Mute Set is uncaptured** — only Read was shown. Almost certainly
   `[I/O, channel, on/off]` by analogy with everything else, but not
   confirmed.
3. **Control IDs `0A`–`0C` are a complete gap.** Between Matrix Mixer (`09`)
   and Input Mode (`0D`) there are three unused byte values with no
   corresponding control shown in any screenshot or dropdown. Either
   reserved, or there are 1–3 more controls this "Central Control" dialog's
   dropdown didn't show in the captured screenshot (worth re-opening that
   dropdown and checking if it scrolls further).
4. **No response/reply frame has been observed at all.** Every example here
   is an outgoing query or command; nothing shows what the matrix sends
   *back* — for a Read, or as an ack for a Set. Unknown: reply framing,
   whether replies reuse Type `63` or use a distinct opcode, how the actual
   value comes back for Scene/Mute/Gain reads.
5. **No checksum/CRC visible** — confirm whether the wire protocol really
   omits one, or whether this config tool's Code field is simplified.
6. **Address byte (`FF`) meaning unconfirmed.** Always `FF` in every capture
   — never seen varying, so we can't tell if it's a fixed constant or a
   device address that matters once one goes to a bus with multiple
   addressable units. Relevant to the transport layer work (RS232
   point-to-point vs. RS485 multi-drop).
7. **Feedback "Level" range** — only `OFF (00)` seen; other levels unknown.
8. **Input Mode "Mode" range** — only `Analog (00)` seen; other modes
   unknown.
9. **Scene number range** — only `01` seen; max scene count unconfirmed.
10. **Matrix size** — inputs/outputs seen only as 1, 3, 4, 6 (Matrix Mixer)
    and up to 8 (Mute's channel dropdown). Actual full I/O count of the
    physical unit not yet confirmed against these numbers.
11. **`Increase/Decreases` control (`05`, inferred)** — no example frame at
    all, value inferred purely from its position in the Control dropdown
    list between Gain and Line/Mic. Likely a relative nudge (vs. Gain's
    presumed absolute set) but completely unconfirmed.
12. **`ALL` channel encoding (`00`) only confirmed for Mute/Output.** Unknown
    whether `ALL` is valid for Gain, Line/Mic, 48V, etc., or specific to Mute.

## Transport layer

Not yet documented — serial port parameters (baud rate, data/stop bits,
parity), physical interface (RS232 vs RS485), and any addressing scheme
implied by the constant `FF` byte above are all still to come.
