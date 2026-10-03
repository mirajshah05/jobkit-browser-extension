#!/usr/bin/env python3
"""Check the exact Git index for unexpected files and common privacy leaks."""
from pathlib import Path
import json
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
ALLOWED = {
    '.gitignore', 'README.md', 'LICENSE', 'SECURITY.md',
    'extension/manifest.json', 'extension/security.js', 'extension/background.js',
    'extension/content.js', 'extension/panel.css', 'extension/popup.html', 'extension/popup.js',
    'scripts/check_publication.py', 'tests/security.test.js', 'tests/filler.test.js',
}

def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)

def inspect_text(name, text):
    errors = []
    patterns = {
        'private home-directory path': r'(?:/(?:Users|home)/|[A-Z]:\\Users\\)[^\s/\\]+',
        'private key': r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
        'GitHub credential': r'\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})\b',
        'AWS access key': r'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b',
        'API credential': r'\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b',
        'JWT': r'\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\b',
        'phone number': r'(?<!\w)(?:\+1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?!\w)',
        'personal profile URL': r'https?://(?:www\.)?linkedin\.com/in/[^\s\"<>]+',
    }
    for label, pattern in patterns.items():
        if re.search(pattern, text):
            errors.append(f'{name}: {label}')
    for email in re.findall(r'[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}', text):
        domain = email.split('@', 1)[1].lower()
        if not (domain.endswith(('.test', '.invalid', '.example')) or domain in {'example.com', 'example.org', 'example.net'}):
            errors.append(f'{name}: non-example email address')
    return errors # Never print the discovered values into CI logs.

def main():
    files = set(git('ls-files', '-z').decode().strip('\0').split('\0')) - {''}
    errors = []
    if files != ALLOWED:
        errors.append(f'Tracked-file allowlist mismatch: {len(files - ALLOWED)} unexpected, {len(ALLOWED - files)} missing')
    for name in sorted(files):
        try:
            content = git('show', f':{name}')
            if b'\0' in content:
                errors.append(f'{name}: binary content is not permitted')
                continue
            errors.extend(inspect_text(name, content.decode('utf-8')))
        except (UnicodeDecodeError, subprocess.CalledProcessError):
            errors.append(f'{name}: unavailable or non-UTF-8 content')
    manifest = json.loads(git('show', ':extension/manifest.json'))
    if manifest.get('permissions') != ['storage']:
        errors.append('Unexpected Chrome API permissions')
    if 'externally_connectable' in manifest:
        errors.append('External extension messaging is not permitted')
    if any('<all_urls>' in item or '*://' in item for item in manifest.get('host_permissions', [])):
        errors.append('Broad host access is not permitted')
    if errors:
        print('\n'.join(errors), file=sys.stderr)
        return 1
    print(f'Publication check passed: {len(files)} explicitly allowed UTF-8 files; no common PII/credential patterns found.')
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
