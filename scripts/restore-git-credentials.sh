#!/bin/sh
# Restore Git SSH authentication and SSH commit-signing credentials after a
# disposable QwenPaw container is recreated. The source directory must live
# outside this Git repository and must never be committed.
set -eu

WORKSPACE_ROOT="${QWENPAW_WORKSPACE_ROOT:-$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)}"
SOURCE="${QWENPAW_GIT_CREDENTIALS_DIR:-$WORKSPACE_ROOT/.secrets/git-credentials}"
HOME_DIR="${HOME:-/root}"

for file in id_ed25519 id_ed25519_sign gitconfig; do
  if [ ! -f "$SOURCE/$file" ]; then
    printf 'missing credential file: %s\n' "$SOURCE/$file" >&2
    exit 1
  fi
done

install -d -m 700 "$HOME_DIR/.ssh"
install -m 600 "$SOURCE/id_ed25519" "$HOME_DIR/.ssh/id_ed25519"
install -m 600 "$SOURCE/id_ed25519_sign" "$HOME_DIR/.ssh/id_ed25519_sign"
install -m 600 "$SOURCE/gitconfig" "$HOME_DIR/.gitconfig"

email="$(git config --global --get user.email)"
if [ -z "$email" ]; then
  printf 'gitconfig has no user.email; refusing to create SSH allowed_signers\n' >&2
  exit 1
fi
printf '%s %s\n' "$email" "$(ssh-keygen -y -f "$HOME_DIR/.ssh/id_ed25519_sign")" > "$HOME_DIR/.ssh/allowed_signers"
chmod 600 "$HOME_DIR/.ssh/allowed_signers"

git config --global gpg.format ssh
git config --global user.signingkey "$HOME_DIR/.ssh/id_ed25519_sign"
git config --global commit.gpgsign true
git config --global gpg.ssh.allowedSignersFile "$HOME_DIR/.ssh/allowed_signers"
printf 'Git credentials restored from %s\n' "$SOURCE"
