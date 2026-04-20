#!/usr/bin/env python3
import json
import os
import sys
import tarfile
import zipfile


def resolve_entries(cwd, entries):
    resolved = []
    for entry in entries:
        source_host_path = os.path.realpath(os.path.join(cwd, entry))
        if not source_host_path.startswith(cwd + os.sep) and source_host_path != cwd:
            raise RuntimeError(f'Archive entry escapes cwd: {entry}')
        resolved.append(source_host_path)
    return resolved


def pack_zip(cwd, output_host_path, entries):
    with zipfile.ZipFile(output_host_path, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for source_host_path in resolve_entries(cwd, entries):
            if os.path.isdir(source_host_path):
                for root, dirs, files in os.walk(source_host_path):
                    dirs.sort()
                    files.sort()
                    rel_root = os.path.relpath(root, cwd)
                    if rel_root != '.':
                        archive.write(root, rel_root.replace(os.sep, '/'))
                    for filename in files:
                        full_path = os.path.join(root, filename)
                        rel_path = os.path.relpath(full_path, cwd)
                        archive.write(full_path, rel_path.replace(os.sep, '/'))
            else:
                rel_path = os.path.relpath(source_host_path, cwd)
                archive.write(source_host_path, rel_path.replace(os.sep, '/'))


def pack_tar(fmt, cwd, output_host_path, entries):
    mode_map = {
        'tar': 'w',
        'tar.gz': 'w:gz',
        'tar.bz2': 'w:bz2',
        'tar.xz': 'w:xz',
    }
    mode = mode_map.get(fmt)
    if mode is None:
        raise RuntimeError(f'Unsupported tar format: {fmt}')
    with tarfile.open(output_host_path, mode) as archive:
        for source_host_path in resolve_entries(cwd, entries):
            arcname = os.path.relpath(source_host_path, cwd).replace(os.sep, '/')
            archive.add(source_host_path, arcname=arcname, recursive=True)


def main():
    if len(sys.argv) != 5:
        raise SystemExit('Usage: archive_pack.py <format> <cwd> <output_path> <json_entries>')
    fmt, cwd, output_host_path, raw_entries = sys.argv[1:5]
    cwd = os.path.realpath(cwd)
    entries = json.loads(raw_entries)
    if not isinstance(entries, list) or len(entries) == 0:
        raise RuntimeError('entries must be a non-empty JSON list')

    if fmt == 'zip':
        pack_zip(cwd, output_host_path, entries)
    else:
        pack_tar(fmt, cwd, output_host_path, entries)


if __name__ == '__main__':
    main()
