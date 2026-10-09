# fcks - F@cking Sync

An experimental, simple, no-frills command-line WebDAV sync client written in plain JavaScript (Bun) with support for virtual folders

```
LOCAL ROOT                                  DAV ROOT
/my/files                                   /remote/files
    |                                             |
    +---- docs/report.pdf <== same path ==> docs/report.pdf
    +---- photos/cat.jpg   <== same path ==> photos/cat.jpg
    |                                             |
    +---------------- SCAN BOTH ------------------+

      fcks push     = remote should look like local
      fcks pull     = local should look like remote
      fcks merge    = keep both sides; newest changed file wins
      fcks scaffold = copy remote folder structure, without files
      fcks free     = delete local files, but keep folders
```

Features:

- No temporary files
- Stateless
- A limited set of commands
- Download or offload folders and subfolders at any time

This project was born out of deep frustration with OneDrive and Nextcloud sync issues on macOS. Nevertheless, fcks supports all platforms. Shortest mental model for commands:

## List of Commands

```sh
fcks                 # help and configured DAV endpoint
fcks --config        # local folder, DAV connection, and remote root
fcks --reset         # delete the complete fcks app-data directory
fcks .               # merge the current folder (same as `fcks merge .`)
fcks push [path]     # make the remote subtree match local
fcks pull [path]     # make the local subtree match remote
fcks merge [path]    # copy both ways; newest changed file wins, never delete
fcks scaffold [path] # recreate the remote folder structure locally
fcks free [path]     # delete local files while retaining their folders
fcks ls [path]       # list shared, local-only, and remote-only entries
fcks push -f .       # skip confirmation (`-f` works with every operation)
fcks pull -s .       # select one remote child folder to pull
fcks push -s .       # select one local child folder to push
```

Short aliases are available: `ph` for `push`, `pl` for `pull`, `sc` for
`scaffold`, and `fr` for `free`.

The path defaults to the current directory. A file path selects its parent
folder. Every target must be the configured local root or a descendant; paths
outside it are rejected. Symbolic-link entries are rejected because WebDAV
cannot preserve their semantics safely. The relative path below
the configured local root is preserved below the configured DAV root. For
example, local root `/foo` and DAV root `/bar` map
`/foo/docs/file.txt` to `/bar/docs/file.txt`.

All mutating commands first display additions, changes, removals, and conflicts,
along with approximate totals to upload, download, or free locally or remotely,
then ask once for confirmation. `-f` auto-confirms; it goes before the optional
path, for example `fcks pull -f ./archive` or `fcks -f ./archive` for an
implicit merge.

`pull -s [path]` opens an interactive list of immediate remote child folders,
creates the selected folder locally, and pulls that subtree. `push -s [path]`
lists immediate local child folders and pushes the selected subtree. `-s` is
only available for `pull` and `push`, and cannot be combined with `-f`.

In an interactive terminal, regular sync commands use OpenTUI for the same
simple flow: scan, review the complete plan, confirm once, and watch progress.

Press `Esc` or `Ctrl+C` to interrupt planning or execution. No new work is
started, active hashes and transfers are aborted, and the result reports how
many operations had already completed. Those completed changes are kept; the
next `push`, `pull`, or `merge` reconciles any partial state. Downloads stream
directly into place without staging files, so interruption can leave a partial
destination file. Interrupted CLI runs exit with status 130.

- `ls` is read-only and lists one folder level, like Unix `ls`.

- `push` and `pull` are intentionally authoritative and may delete files on the
destination side. 

- `merge` never deletes; differing files are copied from the
side with the later modification time. Equal-time content conflicts and
file-versus-directory conflicts are reported and left unchanged. 

- `scaffold` creates missing directories implied by remote files without modifying existing
local files or folders. 

- `free` prints a merge-first safety warning and removes
all local files under the target without removing directories.

Hidden files and folders are included. Empty folders are ignored, like Git.
For `push` and `merge`, a `.fcksignore` file can exclude files and folders
below the directory that contains it. Its syntax follows Git ignore patterns:
blank lines and `#` comments are skipped, glob patterns are supported, a
trailing `/` matches folders, and `!` negates a previous pattern. Nested
`.fcksignore` files apply to their own subtrees. If the same ignore file exists
locally and remotely, the newer copy supplies the rules for that operation.
The `.fcksignore` files themselves are synced normally, and `free` removes them
along with all other local files.

The implementation keeps no sync database. It uses bounded-concurrency scans,
streaming hashes, direct streamed downloads, and streamed uploads, so memory
use does not scale with file size. WebDAV ETags are treated as opaque validators. Equal-sized files at the same path are streamed through SHA-256 on both sides for a correct comparison.

Note: standard WebDAV does not carry portable
POSIX ownership, ACL, executable-bit, or extended-attribute metadata, so those
attributes are not synchronized between machines.

`fcks --reset` recursively removes the whole OS-specific `fcks` app-data
directory, including its configuration and any future cache files. It does not
remove the parent Application Support, config, or AppData directory.

## Release binaries

Publishing a GitHub Release builds standalone `fcks` executables for x64 and
ARM64 Linux, Windows, and macOS. These executables include Bun, so users do not need a
separate Bun installation.

To make the executable available system-wide, rename the binary to `fcks` (`fcks.exe` on Windows) and move it to:

- Windows: `C:\Program Files\fcks\` and add this directory to the system `PATH`
- GNU/Linux: `/usr/local/bin/`
- macOS: `/usr/local/bin/`

## Development

```sh
bun install
bun link
fcks --config
```

`bun link` makes the `fcks` command available. You can also run it without
linking:

```sh
bun run src/cli.js --config
```

The compact config flow asks for a local folder first, then DAV credentials,
verifies the connection, and lets you browse, create, and choose a remote root. Configuration is written with owner-only
permissions to the native user config directory:

- macOS: `~/Library/Application Support/fcks/config.json`
- Linux: `$XDG_CONFIG_HOME/fcks/config.json` or `~/.config/fcks/config.json`
- Windows: `%APPDATA%\\fcks\\config.json`

__Warning__: FCKS stores the password in that protected JSON file.

__Note__: all remote paths are relative to the configured DAV root. Traversal with `..`
is rejected. ETag is cheap server metadata; `getHash()` streams the remote file
through a digest without buffering it in memory.
