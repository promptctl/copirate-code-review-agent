# copirate-review

Installs the CoPirate code review action into a repository and keeps it current.

It is built to be run *before every review*, not once at setup. Each run re-renders every
workflow from its template, re-syncs every credential from the keychain, and writes only
what differs — so a template change or a rotated token reaches a repo the next time
anyone reviews in it, rather than whenever someone remembers to reinstall.

When a rendered workflow does change, the installer commits it to the branch you are on
and pushes. The change rides the pull request you already have open; it never costs you a
second PR to review and merge.

It holds that commit — writing the file, reporting why, and exiting `0` — where committing
would be wrong or impossible: on the default branch, on a detached `HEAD`, or in a
repository with no commits on GitHub yet (whose current branch is about to *become* the
default). A dry run tells you about the hold before you run for real.

It never pushes a branch that is not on the remote already. Converging a workflow is not
a reason to publish someone's local branch, and a push is the one step here that cannot
be taken back — so on an unpublished branch it commits, says so, and lets your own first
push carry it.

```bash
uv tool install --from git+https://github.com/promptctl/copirate-code-review-agent#subdirectory=installer copirate-review

cd ~/code/your-repo
copirate-review install
```

## What one run does

```
repo     promptctl/copirate-code-review-agent (origin) on my-feature-branch
config   /Users/you/.config/copirate-review/config.yaml, .copirate-review.yaml
action   promptctl/copirate-code-review-agent@v1
workflow update    .github/workflows/code-review.yml  (…/templates/pr-review.yml.j2)
secret   sync      CLAUDE_CODE_OAUTH_TOKEN  (keychain item CLAUDE_CODE_OAUTH_TOKEN_SIGNUP)
✓ synced CLAUDE_CODE_OAUTH_TOKEN on promptctl/… (Actions + Dependabot) from keychain item …
✓ wrote .github/workflows/code-review.yml (uses ./)
✓ committed 4a91c02: .github/workflows/code-review.yml
✓ pushed my-feature-branch to origin: .github/workflows/code-review.yml
```

`copirate-review install --dry-run` prints the plan — everything above the `✓` lines — and performs none of it.
`-C <dir>` runs as if started somewhere else.

**GitHub runs what is pushed**, so that is what a workflow's verb reports — not what is
on disk. `create` means the branch has never carried it, `update` that it carries an
older render, `push` that it is committed and not yet on the remote, `unchanged` that
all three agree. Asking only whether the *file* matched would call a workflow converged
the moment it was written, and a run that writes and then holds, or writes and then
fails on a secret, leaves exactly that: a file no commit ever picked up. Every later run
would agree it was fine, and the repository would have no reviewer.

Preconditions are checked first and each fails with its own cause: `git` and `gh`
installed, a git repository, `gh` authenticated, a GitHub repo it can resolve and reach.

Everything else — including each credential's verdict — is decided while the plan is
built, not partway through performing it, so `--dry-run` reaches the same answer the real
run will act on. A dry run that printed `sync` where the run exits `1` would predict
nothing, which is the only thing a dry run is for. The `secret` line says which it is:

```
secret   sync      CLAUDE_CODE_OAUTH_TOKEN  (keychain item CLAUDE_CODE_OAUTH_TOKEN_SIGNUP)
secret   keep      SOME_OTHER_TOKEN  (keychain item … is not on this machine; both stores have it)
secret   MISSING   A_THIRD_TOKEN  (keychain item … is not on this machine)
```

The repository it provisions is the one the **current branch pushes to** — its upstream's
remote, or `origin`. That is a deliberate single answer: asked to work it out alone, `gh`
prefers an `upstream` remote over `origin`, so in a fork clone it would write the reviewer's
credential to the parent repository while the commit went to the fork.

Exit codes are a contract: `0` converged, `1` the world did not cooperate (gh is down, the
keychain is locked), `2` the configuration is wrong. A caller running this before every
review can tell "fix a file and re-run" from "retry later" without reading prose.

## Configuration

Three layers, each deep-merged over the one before it:

1. the defaults shipped in this package
2. `~/.config/copirate-review/config.yaml` — fleet policy for this machine
3. `.copirate-review.yaml`, or `.copirate-review/config.yaml` — the repository's own

A repository declares only its differences. **Nothing needs a config file at all** — a
repo with none gets the shipped defaults, which is the whole point of the fleet layer.

Every file is validated against [`schema.json`](src/copirate_review/schema.json). An
unknown key is fatal, not ignored: a silently-dropped typo leaves a repo paying for
reviews it meant to stop paying for, with nothing anywhere to say so.

```yaml
# .copirate-review.yaml — everything here is optional
action_ref: promptctl/copirate-code-review-agent@v1
commit_message: "chore: converge the AI code review workflow"

# SECRET_NAME: <credential source>. Each is written to BOTH the Actions and the
# Dependabot store, and each is wired into every rendered workflow's `with:` block
# under its own name — declaring a secret provisions it and passes it.
secrets:
  CLAUDE_CODE_OAUTH_TOKEN: keychain:CLAUDE_CODE_OAUTH_TOKEN_SIGNUP

# Keyed by the file each one writes.
workflows:
  .github/workflows/code-review.yml:
    template: pr-review
    inputs:
      MAX_REVIEW_ROUNDS: 12
```

`inputs:` is rendered verbatim into the action step's `with:` block. It is deliberately
open — every input [`action.yml`](../action.yml) accepts is reachable from here, and a new
one needs no release of this installer. Values may be strings, numbers, or booleans; all
three reach the action as the strings it reads.

**A null deletes the key it names.** One rule, at every depth — it is how a repo opts out
of something the fleet layer gave it:

```yaml
secrets:
  CLAUDE_CODE_OAUTH_TOKEN: null     # this repo reviews on a different provider
  ZAI_API_KEY: keychain:ZAI_KEY
workflows:
  .github/workflows/code-review.yml:
    inputs:
      DEPENDENCY_DIFF: null         # back to the action's own default
```

### Credentials

The only source is `keychain:<item>` — a macOS keychain generic-password item, by service
name. The item is *declared*, never derived from the secret name: the action can only read
`CLAUDE_CODE_OAUTH_TOKEN`, but which account's token that holds varies by which account
has quota, so swapping accounts is editing the right-hand side.

No environment variable overrides it. An override is a second, invisible answer to "which
credential does this repo get", firing from whichever process happened to export it, while
the config still names the account you would read there.

The value never enters the installer's memory: it flows keychain → `gh` over an OS pipe,
never bound to a variable, never in `argv`, never printed.

A keychain that cannot be *read* — locked, or an authorization prompt you dismissed — is
its own error and says so. It is deliberately not folded into "the item is missing": that
verdict sends you to create a credential you are already looking at, while the real cause
goes unnamed. Only `security`'s own not-found status means absent.

The keychain is reachable → re-sync, so a rotation propagates. Otherwise the repo's own
two stores are the only evidence, and they answer three ways: present in **both** → warn
that re-syncing is impossible from this machine and leave them; present in **one** → fail,
because the state is broken in a way this machine cannot repair and the missing store's
PRs would review unauthenticated; present in **neither** → fail, because the reviewer
cannot authenticate at all and a later "clean review" would be a lie.

## Templates

A workflow names the template it renders from. That name resolves to `<name>.yml.j2` in
the first of these that has it:

```
.copirate-review/templates/           # this repository
~/.config/copirate-review/templates/  # this machine
the templates shipped in this package
```

So a repo ships its own workflow shape by dropping a file in the first directory. It never
forks the installer, and it keeps every other part of the configuration.

Templates are [Jinja2](https://jinja.palletsprojects.com/), with the delimiters moved out
of GitHub Actions' way — `<< expression >>`, `<% statement %>`, `<# comment #>`. Actions'
own `${{ … }}` passes through untouched, so a template reads and edits as the workflow YAML
it is, with no escaping ritual.

| Variable | |
|---|---|
| `action_ref` | the `uses:` ref for the review step |
| `workflow_path` | where this render will be written |
| `template_name` | this template's name, for the generated-file header |
| `inputs` | the declared inputs, every value already a string |
| `secrets` | the declared secret names, sorted |

`| yaml_quote` encodes a value as a YAML scalar — use it on anything from `inputs`, or a
value containing a quote will corrupt the file it renders into rather than failing.

A variable a template asks for and the config does not supply is an error, never an empty
string: the alternative ships a workflow with a blank `uses:` into a consuming repo.

### Two things the installer does to every render

**The paths it generates lead each workflow's `EXCLUDE_PATTERNS`.** Every workflow it
writes is a derived copy of a template — a finding against one targets the copy, not its
source, and the fix would be silently reverted by the next install. So they are withheld
from review, which is also why no workflow path is repeated in the defaults.

**In the action's own repository, `action_ref` renders as `./`.** That repo must review
each PR with *that PR's* code; a released `@v1` cannot do it. The accommodation selects a
value and nothing else, so the same template converges there as everywhere and every
future template change reaches it like any other consumer.

## Development

```bash
cd installer
uv sync
uv run pytest
```

The decision layer — layering, schema refusal, template resolution, rendering — is pure,
so none of its tests touch a network, a keychain, or a repository.
