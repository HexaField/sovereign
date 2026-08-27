#!/usr/bin/env python3
"""
patch-litellm.py — Idempotent patcher for LiteLLM's Anthropic pass-through.

Applies a fix that consolidates mid-turn system messages into a single entry
at position 0 before forwarding to OpenAI-compat backends (llama-server, ollama,
vllm, etc.). Without this, Claude Code CLI's MCP Server Instructions — injected
as a role:system entry mid-array — cause a Jinja template error on every request:

    Jinja Exception: System message must be at the beginning.

Run after every:
    uv tool upgrade litellm

The fix lives upstream at:
    https://github.com/HexaField/litellm/tree/fix/consolidate-mid-turn-system-messages

Usage:
    python3 services/litellm/patch-litellm.py          # apply (idempotent)
    python3 services/litellm/patch-litellm.py --check  # check only, no writes
    python3 services/litellm/patch-litellm.py --undo   # remove the patch block
"""

import argparse
import os
import sys
import subprocess

# ── Patch identity ────────────────────────────────────────────────────────────

# Sentinel string that marks an already-patched file.
SENTINEL = "## CONSOLIDATE SYSTEM MESSAGES"

# The line immediately before where the patch block is inserted.
ANCHOR = "        self._add_system_message_to_messages(new_messages, anthropic_message_request)"

# The patch block to insert after ANCHOR.
PATCH_BLOCK = """
        ## CONSOLIDATE SYSTEM MESSAGES
        # Some SDK clients (e.g. Claude Code CLI) inject mid-turn system messages
        # within the messages array (e.g. MCP server instructions, system-reminders).
        # OpenAI-compat backends that use Jinja chat templates (e.g. llama-server,
        # ollama, vllm) require ALL system content in a single message at position 0
        # — any system message at a later index raises "System message must be at
        # the beginning." (or equivalent).
        #
        # Root cause: _translate_midturn_system_message_to_openai appends the
        # converted system message at its original position in new_messages. After
        # _add_system_message_to_messages inserts the main system prompt at index 0,
        # the array ends up as [system, …, user, system], which Jinja rejects.
        #
        # Fix: collect all system messages, merge content into one entry at position
        # 0, and remove the duplicates. Non-system messages keep their original order.
        #
        # See: https://github.com/HexaField/litellm/tree/fix/consolidate-mid-turn-system-messages
        system_msgs = [m for m in new_messages if isinstance(m, dict) and m.get("role") == "system"]
        if len(system_msgs) > 1:
            non_system_msgs = [
                m for m in new_messages
                if not (isinstance(m, dict) and m.get("role") == "system")
            ]
            merged_content: list = []
            for sm in system_msgs:
                content = sm.get("content", "")
                if isinstance(content, str):
                    merged_content.append({"type": "text", "text": content})
                elif isinstance(content, list):
                    merged_content.extend(content)
            new_messages = [{"role": "system", "content": merged_content}] + non_system_msgs
"""

# ── Helpers ───────────────────────────────────────────────────────────────────

def find_target() -> str:
    """Return path to transformation.py inside the uv-managed litellm install.

    uv tool dir returns the parent tools directory (e.g. ~/.local/share/uv/tools).
    The litellm tool lives at <tools_dir>/litellm/lib/pythonX.Y/site-packages/...
    """
    try:
        result = subprocess.run(
            ["uv", "tool", "dir"],
            capture_output=True, text=True, check=True,
        )
        tools_dir = result.stdout.strip()
    except FileNotFoundError:
        sys.exit("ERROR: 'uv' not found. Install uv first: https://docs.astral.sh/uv/")
    except subprocess.CalledProcessError as e:
        sys.exit(f"ERROR: 'uv tool dir' failed:\n{e.stderr}")

    tool_dir = os.path.join(tools_dir, "litellm")
    if not os.path.isdir(tool_dir):
        sys.exit(
            f"ERROR: litellm not found at {tool_dir}\n"
            "       Install it first: uv tool install litellm"
        )

    lib_dir = os.path.join(tool_dir, "lib")
    if not os.path.isdir(lib_dir):
        sys.exit(f"ERROR: Expected lib/ directory not found under {tool_dir}")

    # Find the first pythonX.Y sub-directory (sorted descending = newest first).
    for entry in sorted(os.listdir(lib_dir), reverse=True):
        if not entry.startswith("python"):
            continue
        candidate = os.path.join(
            lib_dir, entry, "site-packages",
            "litellm", "llms", "anthropic",
            "experimental_pass_through", "adapters",
            "transformation.py",
        )
        if os.path.isfile(candidate):
            return candidate

    sys.exit(
        f"ERROR: transformation.py not found under {lib_dir}.\n"
        "       The LiteLLM package layout may have changed.\n"
        "       Check the fork for an updated patch:\n"
        "       https://github.com/HexaField/litellm/tree/fix/consolidate-mid-turn-system-messages"
    )


def invalidate_pyc(source_path: str) -> None:
    """Remove the compiled .pyc for source_path so Python recompiles on next import."""
    try:
        import importlib.util
        pyc = importlib.util.cache_from_source(source_path)
        if os.path.exists(pyc):
            os.remove(pyc)
    except Exception:
        pass  # Non-fatal — worst case Python uses stale cache until restart.


def litellm_version() -> str:
    """Read litellm version from the dist-info METADATA in its tool directory."""
    try:
        result = subprocess.run(
            ["uv", "tool", "dir"], capture_output=True, text=True, check=True
        )
        tools_dir = result.stdout.strip()
        lib_dir = os.path.join(tools_dir, "litellm", "lib")
        for py_dir in sorted(os.listdir(lib_dir), reverse=True):
            site_pkgs = os.path.join(lib_dir, py_dir, "site-packages")
            if not os.path.isdir(site_pkgs):
                continue
            for entry in os.listdir(site_pkgs):
                if entry.startswith("litellm-") and entry.endswith(".dist-info"):
                    # e.g. litellm-1.98.0.dist-info
                    return entry[len("litellm-"):-len(".dist-info")]
    except Exception:
        pass
    return "unknown"


# ── Actions ───────────────────────────────────────────────────────────────────

def do_check(target: str) -> bool:
    """Return True if already patched, print status."""
    with open(target) as f:
        src = f.read()
    if SENTINEL in src:
        print(f"✓ Already patched (litellm {litellm_version()})")
        print(f"  {target}")
        return True
    else:
        print(f"✗ Patch not applied (litellm {litellm_version()})")
        print(f"  {target}")
        return False


def do_apply(target: str) -> None:
    """Apply the patch (idempotent)."""
    with open(target) as f:
        src = f.read()

    if SENTINEL in src:
        print(f"✓ Already patched — nothing to do (litellm {litellm_version()})")
        return

    if ANCHOR not in src:
        sys.exit(
            f"ERROR: Insertion anchor not found in {target}\n"
            "       LiteLLM may have refactored this function.\n"
            "       Check the fork for an updated patch:\n"
            "       https://github.com/HexaField/litellm/tree/fix/consolidate-mid-turn-system-messages"
        )

    patched = src.replace(ANCHOR, ANCHOR + PATCH_BLOCK, 1)

    with open(target, "w") as f:
        f.write(patched)

    invalidate_pyc(target)

    print(f"✓ Patch applied (litellm {litellm_version()})")
    print(f"  {target}")
    print()
    print("Restart the LiteLLM service to pick up the change:")
    print("  systemctl --user restart litellm")


def do_undo(target: str) -> None:
    """Remove the patch block (restore to upstream state).

    Uses a regex to strip the block between the ANCHOR line and the sentinel
    through to the line before 'new_kwargs: Final' — this tolerates minor
    comment differences between patch versions.
    """
    import re

    with open(target) as f:
        src = f.read()

    if SENTINEL not in src:
        print("✓ Patch not present — nothing to undo.")
        return

    # Match the blank line + sentinel block up to (but not including) the blank
    # line + new_kwargs declaration that follows the patch.
    # The anchor itself stays; everything after it up to new_kwargs is removed.
    pattern = re.compile(
        r"(\n        ## CONSOLIDATE SYSTEM MESSAGES.*?)"
        r"(?=\n\n        new_kwargs\b)",
        re.DOTALL,
    )
    restored, count = pattern.subn("", src, count=1)

    if count == 0:
        sys.exit(
            "ERROR: Could not locate the patch block for removal.\n"
            "       The file may have changed. Manual cleanup required."
        )

    with open(target, "w") as f:
        f.write(restored)

    invalidate_pyc(target)

    print(f"✓ Patch removed (litellm {litellm_version()})")
    print(f"  {target}")
    print()
    print("Restart the LiteLLM service:")
    print("  systemctl --user restart litellm")


# ── Entry point ───────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Idempotent patcher for LiteLLM mid-turn system message consolidation."
    )
    group = parser.add_mutually_exclusive_group()
    group.add_argument(
        "--check", action="store_true",
        help="Check whether the patch is applied; exit 0 if yes, 1 if no."
    )
    group.add_argument(
        "--undo", action="store_true",
        help="Remove the patch block (restore upstream state)."
    )
    args = parser.parse_args()

    target = find_target()

    if args.check:
        sys.exit(0 if do_check(target) else 1)
    elif args.undo:
        do_undo(target)
    else:
        do_apply(target)


if __name__ == "__main__":
    main()
