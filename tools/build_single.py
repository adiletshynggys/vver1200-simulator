#!/usr/bin/env python3
"""Inline css/ and js/ into one self-contained HTML file (dist/vver1200-sim.html).

GitHub Pages serves index.html with its separate files; the single file is handy for
sharing, offline use, or hosting anywhere that wants one page.
"""
import pathlib, re, sys

root = pathlib.Path(__file__).resolve().parent.parent
html = (root / "index.html").read_text(encoding="utf-8")

def inline_css(m):
    return "<style>\n" + (root / m.group(1)).read_text(encoding="utf-8") + "\n</style>"

def inline_js(m):
    code = (root / m.group(1)).read_text(encoding="utf-8").replace("</script", "<\\/script")
    return "<script>\n" + code + "\n</script>"

html = re.sub(r'<link rel="stylesheet" href="(css/[^"]+)">', inline_css, html)
html = re.sub(r'<script src="(js/[^"]+)"></script>', inline_js, html)

out = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else root / "dist" / "vver1200-sim.html"
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(html, encoding="utf-8")
print(f"wrote {out} ({out.stat().st_size / 1024:.0f} KB)")
