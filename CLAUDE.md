# ekko-desk

A projected interactive desk for Ekko. `PLAN.md` holds the design, the message format, the phases and the decisions; read it first.

## Working rules

- **Planning:**
  - Get the plan for each phase approved before building it.
  - Work in small steps, and keep answers concise.
- **Git:**
  - The user runs git themselves (branch, commit, push). Give them the commands and the PR text.
  - Never add Co-Authored-By lines or "Generated with Claude Code" to commits or PRs.
- **Secrets:**
  - Never print a key, token or `.env` value; only check whether it's present.
  - Keep keys and the tailnet name out of committed files; `.env.example` holds names only.
  - Scan for secrets before every push.
- **Other services and the Pi:**
  - Ask before changing anything outside this repo: Ekko (`C:\Users\Jarre\RiderProjects\EkkoHomeAgent`), ekko-deck, or the Pi.
  - Ekko's desk domain (phase 3) is built in the EkkoHomeAgent repo, whose `docs/ARCHITECTURE.md` gets DR-39.
  - Don't register services or scheduled tasks yourself (`systemctl enable`, `tailscale serve`, logon tasks). Give the user the command to run.
  - Tailscale SSH to the Pi hangs, so the user runs Pi commands and pastes the output.
- **The Pi's limits:** it has had CPU problems. Pages redraw only when something changes, with no continuous animation, blur, shadows or transitions.
  - The one exception is the toys, the ball and the two fighters (PLAN.md, "Toys"). They animate frame by frame only while something moves (a throw, a round of at most 60 s), drawn as a few elements updated directly outside Preact, and ask for no frames at rest.
- **Ports:** never pick a port browsers and Node refuse ("bad port"): 5060, 5061, 6000, 6665–6669, 10080.
