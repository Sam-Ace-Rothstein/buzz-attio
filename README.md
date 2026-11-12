# Attio deals for Buzz (`kybernesis.attio`)

A Buzz plugin that puts Kybernesis's Attio deals inside Buzz.

- **Deal button in every channel header.** It opens the Attio deal linked to
  that channel: stage (changeable), value, owner, AI maturity, audit tier and
  fee, package, budget, approvers, next step (editable), open tasks (tick to
  complete, add new ones), and notes. A channel with no deal yet can be linked
  to an existing deal, or get a new one.
- **Pipeline page.** Every deal by stage, the active value, and active deals
  whose next step is missing or overdue.
- **Save to Attio**, on any message. It saves the message as a note on the
  channel's deal.
- **Agent tools** for agents the Buzz app runs: `attio_find_deals`,
  `attio_deal_for_channel`, `attio_get_deal`, `attio_update_deal`,
  `attio_add_note`, `attio_add_task`, `attio_complete_task`, `attio_pipeline`.

## Install (each teammate, once)

1. **Make an Attio access token.** In Attio go to Settings → Developers →
   Access tokens → Create, and give it read and write on records, notes,
   tasks and list entries, plus read on object configuration and members.
2. **Put it in your Mac's Keychain.** In Terminal run the line below, then
   paste the token when asked. It never appears on screen or in a file.
   ```
   security add-generic-password -a "$USER" -s kybernesis-attio-api-key -w
   ```
3. **Install the plugin.** In Buzz go to Settings → Plugins → Manage plugins →
   Add, then either **Browse** to this folder or enter the Git repo. Review the
   host access (only `api.attio.com`, plus reading that one Keychain item),
   then choose **Install plugin**.
4. **Check the connection.** Settings → Attio should say "Connected to the
   Kybernesis workspace".

The first time the plugin reads the key, macOS may ask whether `security` can
use the Keychain item. Choose **Always Allow**.

## How deals and channels connect

The deal's **Buzz Channel** field holds `#channel-name [channel-id]`. The
plugin finds a channel's deal by that id, so renaming a channel doesn't break
the link.

## Linking channels

A client channel is linked once, from the Deal button: search for the deal, or
create one. A channel holds one deal; a deal can be linked to one channel.
