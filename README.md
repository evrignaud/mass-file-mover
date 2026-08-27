# mass-file-mover

Reorganise a whole tree of files by editing a plain-text listing.

The command writes the files it finds to a text file, you rearrange that text
in your editor, and the command puts the files where the text now says they
belong. Moving a hundred files across a dozen directories becomes a few
keystrokes in a buffer you can already navigate.

```console
$ mass-file-mover list photos -o plan.txt   # write the tree out
$ $EDITOR plan.txt                          # rearrange it
$ mass-file-mover move plan.txt photos sorted --dry-run
$ mass-file-mover move plan.txt photos sorted --journal undo.json
```

## Install

```console
$ npm install --global mass-file-mover
```

Both `mass-file-mover` and the shorter `mfm` are installed. Node 22.13 or
later is required.

To run it once without installing:

```console
$ npx mass-file-mover list photos -o plan.txt
```

## The three-step loop

Take a directory that needs sorting out:

```
photos/
├── 2019/
│   ├── holiday.jpg
│   └── summer/
│       ├── IMG_0042.jpg
│       └── IMG_0042.raw
└── dump/
    ├── IMG_0100.jpg
    └── thumbs.db
```

**1. List it.**

```console
$ mass-file-mover list photos -o plan.txt
5 files listed in 'plan.txt'
```

```text
2019/
  holiday.jpg
  summer/
    IMG_0042.jpg
    IMG_0042.raw
dump/
  IMG_0100.jpg
  thumbs.db
```

**2. Edit it.** Rename the directory headers, move entries between them, drop a
`[DEL]` in front of what you no longer want:

```text
# 2019 holidays, tidied up
2019/
  holiday.jpg
  best/
    IMG_0042
inbox/
  IMG_0100.jpg
  [DEL] thumbs.db
```

**3. Apply it.** Check first:

```console
$ mass-file-mover move plan.txt photos sorted --dry-run
Would remove 'photos/dump/thumbs.db'
Would move 'photos/2019/holiday.jpg' --> 'sorted/2019/holiday.jpg'
Would move 'photos/2019/summer/IMG_0042.jpg' --> 'sorted/2019/best/IMG_0042.jpg'
Would move 'photos/2019/summer/IMG_0042.raw' --> 'sorted/2019/best/IMG_0042.raw'
Would move 'photos/dump/IMG_0100.jpg' --> 'sorted/inbox/IMG_0100.jpg'
4 to move, 1 to delete (dry run, nothing changed)
```

Then commit to it:

```console
$ mass-file-mover move plan.txt photos sorted --journal undo.json
4 moved, 1 deleted
```

`sorted/` now holds the tree the text described, the emptied directories under
`photos/` are gone, and `undo.json` knows how to put it all back.

Notice that the single entry `IMG_0042`, written without an extension, carried
both the `.jpg` and the `.raw`.

## The listing format

A line ending in `/` opens a directory. The more deeply indented lines below it
are its contents. Indentation is two spaces per level and is what decides where
an entry lands, so keep it intact when editing.

An entry that steps back out sits in the directory of its own level:

```text
a/
  b/
    one.txt    ends up in a/b/
  two.txt      ends up in a/, not a/b/
```

Other rules:

- `[DEL] name` deletes the file instead of moving it. The marker works at any
  indentation.
- A name written **without an extension** carries every file sharing that stem.
  `IMG_0042` takes `IMG_0042.jpg` and `IMG_0042.raw` together, each keeping its
  own extension.
- Lines starting with `#` are ignored, so a plan can be annotated.
- Blank lines are ignored.
- Listings are written with `/` separators and read the same way, so a plan
  produced on Windows applies on Linux and the other way round. CRLF endings and
  a leading byte order mark are both accepted.

### What a listing cannot do

**It cannot rename files.** An entry is matched to a file by its name, so the
listing controls which *directory* a file ends up in, not what it is *called*.
Change `holiday.jpg` to `beach.jpg` and the command looks for a file called
`beach.jpg`, does not find one, and reports it:

```console
ERR: File 'beach.jpg' does not exist
```

The format carries no pairing between an old name and a new one, so there is no
way to tell which file a changed line refers to. Use a renaming tool for that,
then this one to move the results.

### Choosing a layout

`--format tree` is the default. Two others exist for when they read better or
are easier to process:

<table>
<tr><th><code>tree</code></th><th><code>flat-tree</code></th><th><code>files</code></th></tr>
<tr><td>

```text
2019/
  holiday.jpg
  summer/
    IMG_0042.jpg
    IMG_0042.raw
dump/
  IMG_0100.jpg
  thumbs.db
```

</td><td>

```text
2019/
  holiday.jpg
2019/summer/
  IMG_0042.jpg
  IMG_0042.raw
dump/
  IMG_0100.jpg
  thumbs.db
```

</td><td>

```text
2019/holiday.jpg
2019/summer/IMG_0042.jpg
2019/summer/IMG_0042.raw
dump/IMG_0100.jpg
dump/thumbs.db
```

</td></tr>
</table>

`tree` nests, `flat-tree` spells out each directory once at the left margin, and
`files` gives one full path per line. All three are read back by `move`, and you
can mix their conventions in a hand-written plan.

## Undoing a run

Pass `--journal <file>` to `move` and it records what it did:

```console
$ mass-file-mover move plan.txt photos sorted --journal undo.json
$ mass-file-mover undo undo.json
4 restored, 1 cannot be restored
WARN: Cannot restore deleted file 'photos/dump/thumbs.db'
```

Moved files go back where they came from, source directories that were pruned
are recreated, and copies are removed. Deletions cannot be undone, the content
is gone, so `undo` reports them rather than pretending the tree is whole again.
`undo --dry-run` shows the reversal without performing it.

## Copying instead of moving

`--copy` builds the reorganised tree and leaves the original untouched. Nothing
is deleted and no directory is pruned, so a `[DEL]` entry simply means "leave
this one out".

```console
$ mass-file-mover move plan.txt photos sorted --copy
4 copied
```

## When a destination is taken

`--on-conflict` decides what happens when a file already occupies a
destination:

| Value | Behaviour |
| --- | --- |
| `rename` | give the incoming file a `name-1.ext` suffix (default) |
| `skip` | leave both the existing file and the source alone |
| `overwrite` | replace the file that is in the way |
| `fail` | report the collision and exit non-zero, changing nothing for that entry |

Destinations are worked out for the whole plan before anything moves, so two
files of the same name coming from different directories resolve predictably to
`dup.txt` and `dup-1.txt`.

## Leaving files out

`.git`, `.fim` and `node_modules` are skipped by default. Add your own with
`--ignore`, which takes a glob and can be repeated:

```console
$ mass-file-mover list . -i '*.log' -i build -o plan.txt
```

Patterns follow `.gitignore` conventions: a bare name matches at any depth, a
name containing `/` stays anchored to the scanned root, and either form also
covers everything beneath a directory it matches. `--no-default-ignores` turns
the built-in list off.

## Commands

```text
list [directory]                              write a listing
list-files|list-flat-tree|list-tree [dir] [out]   the original command names
move [moveList] [directory] [destination]     apply a listing
undo <journal>                                walk back a recorded run
```

`list` options:

| Option | Meaning |
| --- | --- |
| `-f, --format <format>` | `files`, `flat-tree` or `tree` (default `tree`) |
| `-o, --output <file>` | where to write it (default `fileList`) |

`move` options:

| Option | Meaning |
| --- | --- |
| `-n, --dry-run` | report the plan, change nothing |
| `-c, --copy` | copy instead of moving |
| `--on-conflict <strategy>` | `rename`, `skip`, `overwrite` or `fail` |
| `--journal <file>` | record the run so `undo` can reverse it |
| `--no-prune` | keep source directories that end up empty |
| `-j, --concurrency <count>` | operations in flight at once (default 8) |

`undo` options: `-n, --dry-run`, `--no-prune`.

Shared by every command: `-i, --ignore <pattern>`,
`--no-default-ignores`, `-v, --verbose`, `-q, --quiet`, `--json`, `--no-color`,
plus `-h, --help` and `-V, --version`.

The original invocations still work unchanged:

```console
$ mass-file-mover list-tree photos plan.txt
$ mass-file-mover move plan.txt photos sorted
```

## Scripting it

`--json` prints a machine-readable report on stdout and pushes the log lines to
stderr, so the output stays parseable:

```console
$ mass-file-mover move plan.txt photos sorted --json 2>/dev/null | jq .moved
4
```

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | everything asked for was carried out |
| `1` | something failed, was not found, or the command line was wrong |

A run that could not do all of its work reports `1`, so `&&` chains behave.

## Using it as a library

```js
import { listDirectory, moveFiles, LIST_TYPES } from 'mass-file-mover'

listDirectory(LIST_TYPES.tree, 'photos', 'plan.txt')

const summary = await moveFiles('plan.txt', 'photos', 'sorted', {
  dryRun: true
})

console.log(summary.moved, 'files would move')
```

`moveFiles` resolves to a summary and, for a real run, the list of operations
performed, which is what `writeJournal` records. Both accept a `logger`; the
exported `silentLogger` keeps a library run quiet.

## Development

```console
$ npm install
$ npm test              # vitest
$ npm run test:coverage
$ npm run lint
$ npm run check         # lint and test
```

CI runs the suite on Linux, macOS and Windows against Node 22 and 24, and
separately installs the packed tarball to drive the real binary through a
list, move and undo cycle. The platform matrix is deliberate: nearly every bug
fixed in version 2 was a path-separator or path-resolution fault that only
appeared on one platform.

## License

[MIT](LICENSE)
