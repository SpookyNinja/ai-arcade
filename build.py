#!/usr/bin/env python3
"""Build dist/ai-arcade.html (full document) and dist/artifact.html (no doctype/html/head/body)."""
import glob, os, re

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, 'src')
DIST = os.path.join(ROOT, 'dist')


def read(p):
    with open(p, encoding='utf-8') as f:
        return f.read()


def script_tag(name, code):
    code = code.replace('</script', '<\\/script')
    return '<script>\n// ---- %s ----\n%s\n</script>' % (name, code)


def main():
    tpl = read(os.path.join(SRC, 'index.template.html'))
    css = read(os.path.join(SRC, 'shell.css')).replace('</style', '<\\/style')
    files = [('core.js', os.path.join(SRC, 'core.js'))]
    for p in sorted(glob.glob(os.path.join(SRC, 'games', '*.js'))):
        files.append(('games/' + os.path.basename(p), p))
    files.append(('shell.js', os.path.join(SRC, 'shell.js')))
    # separate <script> tags: a syntax error in one game cannot take down the others
    js = '\n'.join(script_tag(n, read(p)) for n, p in files)

    assert '/*CSS*/' in tpl and '<script>/*JS*/</script>' in tpl
    full = tpl.replace('/*CSS*/', css).replace('<script>/*JS*/</script>', js)

    os.makedirs(DIST, exist_ok=True)
    with open(os.path.join(DIST, 'ai-arcade.html'), 'w', encoding='utf-8') as f:
        f.write(full)
    # GitHub Pages serves the standalone build from the repo root
    with open(os.path.join(ROOT, 'index.html'), 'w', encoding='utf-8') as f:
        f.write(full)

    # artifact: only title, meta, font link, style, body markup, scripts
    title = re.search(r'<title>.*?</title>', full, re.S).group(0)
    meta = re.search(r'<meta name="claude:viewport-fit-sides"[^>]*>', full).group(0)
    link = re.search(r'<link rel="stylesheet"[^>]*>', full).group(0)
    style = re.search(r'<style>.*?</style>', full, re.S).group(0)
    body = re.search(r'<body>(.*)</body>', full, re.S).group(1).strip()
    art = '\n'.join([title, meta, link, style, body]) + '\n'
    assert not re.search(r'<!doctype|</?(html|head|body)[\s>]', art, re.I), 'wrapper tag leaked'
    with open(os.path.join(DIST, 'artifact.html'), 'w', encoding='utf-8') as f:
        f.write(art)
    print('built %d js files; ai-arcade.html %d KB, artifact.html %d KB'
          % (len(files), len(full) // 1024, len(art) // 1024))


if __name__ == '__main__':
    main()
