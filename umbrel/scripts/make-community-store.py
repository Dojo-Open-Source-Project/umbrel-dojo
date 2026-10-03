#!/usr/bin/env python3
"""Generate the Dojo OSP community app store from umbrel/dojo.

    ./umbrel/scripts/make-community-store.py [output-dir]

umbrelOS lets you add any GitHub repository as an extra app store, which is how
this package can be installed before the official umbrel-apps submission lands.
A community store has two hard requirements (see
github.com/getumbrel/umbrel-community-app-store):

  * umbrel-app-store.yml at the repository ROOT, and the app directory at the
    root too -- this repository's root is the vendored Dojo tree, so it cannot
    itself be a store;
  * the store id must PREFIX every app id, so the app cannot be plain `dojo`.

That second one is not cosmetic: umbrelOS derives container names from the app
id as `<app-id>_<service>_1`, so every hardcoded container name in the compose
file has to move with it. This script does that transform, asserting on every
substitution so a rename upstream fails the build rather than producing a store
that installs and then quietly cannot talk to itself.

Everything else in the package already derives its paths from $APP_ID
(torrc.template, hooks/pre-start, exports.sh) and needs no rewriting at all.
"""

import os
import pathlib
import re
import shutil
import sys
import tempfile

STORE_ID = "dojo-osp"
STORE_NAME = "Dojo OSP"
APP_ID = f"{STORE_ID}-dojo"

# The official package's ports and static IP are absolute, so a device with both
# this and the official `dojo` app installed would collide. Move ours.
PORT_PROXY = ("3023", "3025")
PORT_API = ('APP_DOJO_API_PORT="3024"', 'APP_DOJO_API_PORT="3026"')
NGINX_IP = ('APP_DOJO_NGINX_IP="10.21.21.31"', 'APP_DOJO_NGINX_IP="10.21.21.32"')

# The repository this store is published from. Override with STORE_REPO_SLUG if
# you fork it somewhere else; both URLs below derive from it.
STORE_REPO_SLUG = os.environ.get(
    "STORE_REPO_SLUG", "linkinparkrulz/umbrel-dojo-osp-store"
)
STORE_REPO = f"https://github.com/{STORE_REPO_SLUG}"

# Community stores render the icon from a URL in the manifest rather than from
# Umbrel's asset repo. HEAD resolves to whatever the store repo's default branch
# turns out to be, so this does not care whether it ends up main or master.
ICON_URL = (
    f"https://raw.githubusercontent.com/{STORE_REPO_SLUG}/HEAD/{APP_ID}/icon.svg"
)

# Gallery works the same way. The official store takes bare filenames and
# resolves them against Umbrel's own asset repo; a community store has no such
# repo, so umbreld takes whatever string is given and treats it as a URL -- the
# upstream sparkles-hello-world example uses imgur links. Hence absolute URLs
# into this store, pointing at images the generator copies in below.
GALLERY = ("1.jpg", "2.jpg", "3.jpg", "4.jpg")
GALLERY_SOURCE = "umbrel/assets/gallery"
GALLERY_URLS = [
    f"https://raw.githubusercontent.com/{STORE_REPO_SLUG}/HEAD/{APP_ID}/{name}"
    for name in GALLERY
]

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
PACKAGE = REPO_ROOT / "umbrel" / "dojo"


def replace_exactly(text, old, new, expected, label):
    """Substitute exactly `expected` occurrences, or fail loudly."""
    count = text.count(old)
    if count != expected:
        raise SystemExit(
            f"{label}: expected {expected} occurrence(s) of {old!r}, found {count}"
        )
    return text.replace(old, new)


def replace_once(text, old, new, label):
    return replace_exactly(text, old, new, 1, label)


def transform_compose(text):
    hsv3_before = text.count("hsv3dojo")

    # <app-id>_<service>_1 is the container name umbrelOS injects.
    text, n = re.subn(
        r"\bdojo_(nginx|db|node|soroban)_1\b", rf"{APP_ID}_\1_1", text
    )
    if n != 6:
        raise SystemExit(f"compose: expected 6 container names, rewrote {n}")

    # The Tor hidden-service directory is app-<app-id>-api. Two services mount
    # it: node (Dojo reads its own onion for auth47) and nginx (the Connect page
    # serves it at /onion). Note this must not touch /var/lib/tor/hsv3dojo,
    # which is Dojo's own internal path and is not app-id derived.
    text = replace_exactly(
        text, "${TOR_DATA_DIR}/app-dojo-api", f"${{TOR_DATA_DIR}}/app-{APP_ID}-api",
        2, "compose",
    )
    if text.count("hsv3dojo") != hsv3_before:
        raise SystemExit("compose: Dojo's internal hsv3dojo path was clobbered")
    return text


def transform_manifest(text):
    text = replace_once(text, "id: dojo\n", f"id: {APP_ID}\n", "manifest id")
    text = replace_once(
        text, f"port: {PORT_PROXY[0]}", f"port: {PORT_PROXY[1]}", "manifest port"
    )
    # Icon goes right after the name, where community manifests carry it.
    text = replace_once(
        text, "name: Dojo\n", f"name: Dojo\nicon: {ICON_URL}\n", "manifest icon"
    )
    # The official package ships `gallery: []` because Umbrel's team produces
    # those images. A community store has to supply its own.
    gallery = "\n".join(f"  - {url}" for url in GALLERY_URLS)
    text = replace_once(
        text, "gallery: []\n", f"gallery:\n{gallery}\n", "manifest gallery"
    )
    # `submission` points at a pull request in the official store; here the
    # store repo itself is the honest answer.
    text = re.sub(r"^# TODO:.*\n", "", text, flags=re.MULTILINE)
    text = re.sub(r"^submission: .*$", f"submission: {STORE_REPO}", text, flags=re.MULTILINE)
    return text


def transform_exports(text):
    text = replace_once(text, PORT_API[0], PORT_API[1], "exports api port")
    text = replace_once(text, NGINX_IP[0], NGINX_IP[1], "exports nginx ip")
    return text


def make_icon(source):
    """Wrap the glyph on a solid tile so it renders on Umbrel's home screen."""
    svg = source.read_text()
    if 'fill="currentColor"' not in svg:
        raise SystemExit("icon: expected the glyph to use currentColor")
    svg = svg.replace('fill="currentColor"', 'fill="#ffffff"')
    return svg.replace(
        "<g>",
        '<rect width="500" height="500" rx="110" fill="#16161d"/>\n<g '
        'transform="translate(75 75) scale(0.7)">',
        1,
    )


def main(out_dir):
    out = pathlib.Path(out_dir)
    if out.exists():
        # Clear the generated tree but keep .git: the usual workflow is to run
        # this straight into a clone of the store repo, and blowing the clone
        # away turns every update into a fresh init against a remote that
        # already has history.
        for entry in out.iterdir():
            if entry.name == ".git":
                continue
            if entry.is_dir() and not entry.is_symlink():
                shutil.rmtree(entry)
            else:
                entry.unlink()
    else:
        out.mkdir(parents=True)
    app_out = out / APP_ID
    shutil.copytree(PACKAGE, app_out)

    (out / "umbrel-app-store.yml").write_text(
        f'id: "{STORE_ID}"\nname: "{STORE_NAME}"\n'
    )

    for name, fn in (
        ("docker-compose.yml", transform_compose),
        ("umbrel-app.yml", transform_manifest),
        ("exports.sh", transform_exports),
    ):
        path = app_out / name
        path.write_text(fn(path.read_text()))

    (app_out / "icon.svg").write_text(
        make_icon(REPO_ROOT / "umbrel/images/nginx/connect/img/dojo.svg")
    )

    for name in GALLERY:
        source = REPO_ROOT / GALLERY_SOURCE / name
        if not source.exists():
            raise SystemExit(f"gallery: missing {source}")
        shutil.copyfile(source, app_out / name)

    # PR-BODY belongs to the official submission, not to the store.
    for stray in ("PR-BODY.md",):
        (app_out / stray).unlink(missing_ok=True)

    print(f"store written to {out}")
    print(f"  store id : {STORE_ID}")
    print(f"  app id   : {APP_ID}")

    # Three separate incidents have ended with a complete store written into a
    # directory nothing tracks, followed by a "nothing to commit, working tree
    # clean" in the real clone -- which reads like success. Say so here, where
    # it is still cheap to notice. Not an error: generating into a scratch
    # directory is a perfectly good thing to do, it just cannot be pushed.
    if not (out / ".git").exists():
        print(f"  note     : {out} is not a git checkout; nothing can be pushed from here")


if __name__ == "__main__":
    # Outside the repository by default: the root is the vendored Dojo tree and
    # adding a build directory to its .gitignore would be another delta to carry.
    default = pathlib.Path(tempfile.gettempdir()) / "umbrel-dojo-osp-store"
    main(sys.argv[1] if len(sys.argv) > 1 else default)
