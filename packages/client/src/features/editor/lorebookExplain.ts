// What each lorebook entry setting does, in plain words: the explanation shown on hover and
// focus wherever the setting is (an entry's settings, its header's badges, "Change for
// selected…"), so SillyTavern's jargon reads the same everywhere.
export const EXPLAIN = {
  enabled: "Off, the entry is never sent, whatever matches. The book itself stays on.",
  strategy: "Choose when to include the entry: on a key match, always, or by similarity (not yet available).",
  constant: "Constant: always sent while it's enabled, with no key needed.",
  normal: "Normal: sent when one of its primary keys appears in the messages it scans.",
  vectorized: "Match by similarity to the chat. Not available yet: this option matches keys instead.",
  position:
    "Where its text goes when the chat lets entries go where they say; by default chats put every entry just after the history.",
  depth: "At a depth: how many messages back from the newest its text is placed.",
  role: "At a depth: whose message its text is sent as.",
  order: "Order: higher goes first, and is kept first when the budget runs out.",
  probability: "Trigger %: the chance it's sent when it matches, while “Use the trigger %” is on.",
  use_probability: "Off, a match always sends it, whatever its trigger %.",
  keys: "Include the entry when any key appears in the messages it checks. One key per line; /pattern/flags is a regular expression.",
  keys_line:
    "Its primary keys: any one appearing in the chat sends it. Click to edit them, one per line; /pattern/flags is a regular expression.",
  settings: "Change when the entry is included and where its text goes.",
  selective: "Secondary keys: a primary key match also has to pass this filter.",
  selective_logic:
    "How the secondary keys filter a match: AND ANY (one of them too), AND ALL (all of them too), NOT ANY (none of them), NOT ALL (not all of them).",
  secondary_keys: "Checked only after a primary key matched, as the logic says.",
  case_sensitive: "Match the capitals in each key exactly. Default: off.",
  match_whole_words: "Match whole words only, excluding parts of longer words. Default: on.",
  scan_depth: "How many of the latest messages it looks for its keys in. Empty: the book's, else 2.",
  match_sources: "Besides the messages, where else its keys are looked for.",
  triggers: "Which kinds of reply it's used for: none ticked is all of them.",
  group: "Inclusion group: of the entries in one group that match, only one is sent. A comma is part of the name.",
  group_override: "Prioritize: when several of its group match, this one is chosen.",
  group_weight: "Its chance of being the one its group sends. Not used yet: chats don't choose by weight.",
  use_group_scoring: "Choose among the matching entries with the most keys found in their group.",
  exclude_recursion: "Non-recursable: other entries' text can't trigger it, only the messages.",
  prevent_recursion: "Prevent further recursion: its text doesn't trigger other entries.",
  delay_until_recursion:
    "Delay until recursion: matched only once another entry's text is scanned, not the messages alone.",
  ignore_budget:
    "Still included once the lorebook budget, or this book's own, is used up. Its text still counts toward them.",
  sticky: "Sticky: keeps the entry included for this many messages after a match.",
  cooldown: "Cooldown: waits this many messages after the entry stops before allowing another match.",
  delay: "Delay: not included until the chat has this many messages.",
  outlet_name: "Sent where a prompt has {{outlet::this name}}.",
  content: "The text sent to the model when the entry is in."
} as const
