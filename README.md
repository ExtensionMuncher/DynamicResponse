# Dynamic Response

A standalone SillyTavern extension that lets the model pause mid-scene and hand
the turn back to you for a quick response — without forcing a full separate AI
reply just to acknowledge a one-line action.

When the model emits a `<dynamic_response>` tag, the extension strips the tag from the
message (it never pollutes your chat history), and shows a small banner just
above the input bar. You answer through the normal text field as a regular user
turn. That keeps the turn structure clean, so the model never starts roleplaying
as you.

## How it works

- The model ends a message with `<dynamic_response>optional text</dynamic_response>`.
- The tag is removed from the stored message; the surrounding prose is untouched.
- A banner appears above the input bar showing the tag's text (or your default
  text if the tag is left empty).
- You type your reply and send it as a normal turn — the banner clears itself.
- If a regenerated/swiped message has no tag, the banner clears automatically.
- Click the banner to dismiss it manually (with a confirm step by default).

The pending banner is stored per-chat and survives page refresh, tab close, and
restarting SillyTavern.

## The tag

```
<dynamic_response>label text here</dynamic_response>
```

- The label is optional. `<dynamic_response></dynamic_response>` shows your default text.
- A self-closing style `<dynamic_response>label<dynamic_response/>` also works.
- The tag is case-insensitive.

## Settings

Found under Extensions settings as **Dynamic Response**:

- **Enabled** — master on/off for detection and the banner.
- **Confirm before dismissing banner** — when on (default), clicking the banner
  asks Yes/Cancel before clearing. Turn off for one-click dismiss.
- **Default banner text** — what the banner shows when the model emits an empty
  tag. Defaults to "Your turn."

## Prompt instruction (paste into your system prompt / preset)

The extension only *catches* the tag — it does not make the model emit it. Add an
instruction so the model knows the tag exists and, more importantly, when **not**
to use it. The wording below is deliberately weighted toward restraint, because
the common failure is over-use.

```
You have access to a special tag: <dynamic_response>short prompt</dynamic_response>.

Use it ONLY when the scene has reached a natural beat where {{user}} must respond
or act next, and continuing on their behalf would either put words in their mouth
or waste a full reply on a trivial action. When you use it, place it on its own
line at the very END of your message, after your normal prose, echoing the beat
the scene just landed on. The text inside should be a brief in-fiction cue, e.g.
<dynamic_response>He holds out his hand, waiting for the wrench.</dynamic_response> or
<dynamic_response>What do you do?</dynamic_response>. You may leave it empty.

Do NOT use the tag in most messages. Do NOT use it when the scene flows fine on
its own, when no decision or response from {{user}} is needed, or when you can
continue the narration naturally. When in doubt, leave it out and keep writing.
Never use it more than once in a single message.
```

Tune this over a few sessions. If your model over-fires the tag, add another
sentence emphasizing restraint; if it under-fires, soften the "do not" lines.
Clicking a banner to dismiss it is your release valve for the occasional
over-fire — nothing breaks if the model tags a beat that didn't need it.

## Notes

- Reusing the native input field means submit-on-enter, slash commands, quick
  replies, and the send button all keep working untouched.
- Banner styling inherits your active SillyTavern theme.
