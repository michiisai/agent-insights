# Deck source

The presentation is **generated** from these Python files. Rendered output lives one level up:

- `../Agent-Insights-Final-Presentation.pptx`
- `../Agent-Insights-Final-Presentation.html` (self-contained preview, presenter mode)

## Pick one source of truth

You cannot edit both the `.pptx` and these scripts. Rebuilding **overwrites the `.pptx` completely**,
including any photos, screenshots or wording you changed in PowerPoint.

**Once you start adding images in PowerPoint, stop rebuilding.** From that point the `.pptx` is
the source of truth and these files are a historical record.

## Editing here (before you add images)

Content lives in plain Python lists near the top of each slide function, so most edits are
one-line string changes.

| File | Slides |
|---|---|
| `slides_a.py` | title, thesis, agenda, dividers, problem, OTel primer, agent host, harness table |
| `slides_b.py` | architecture, session model, storage, surfaces, normalization I/II/III |
| `slides_c.py` | demo, impact, what shipped, next steps, learnings, appendix |
| `slides_d.py` | about me, VS Code context, goal, pipeline, use cases, challenges, outcomes, thanks |
| `theme.py` | colours, fonts, layout helpers, footer text |
| `build.py` | slide order |

Rebuild:

```powershell
$py = "C:\Users\Michelle\AppData\Local\Python\pythoncore-3.14-64\python.exe"
& $py docs\deck\build.py docs\Agent-Insights-Final-Presentation.pptx
```

Regenerate the HTML preview (needs PNGs exported from PowerPoint first — see below):

```powershell
& $py docs\deck\build_html.py docs\Agent-Insights-Final-Presentation.pptx <png-dir> docs\Agent-Insights-Final-Presentation.html
```

## Gotchas

- **Slide numbers are automatic.** `footer()` writes a `{{N}}` token that `number_pages()`
  resolves at save time, so reordering slides in `build.py` can't desynchronise them.
- **Text overflow is invisible to the generator.** `python-pptx` will happily let text spill past
  a shape. Always render to PNG and look before trusting a change.
- **Speaker notes carry timing cues** in the form `[m:ss - m:ss]`. If you add or remove a slide,
  the cues after it are wrong until you update them by hand.
- Slides whose notes say `OPTIONAL` are the designated cut list.

## Rendering to PNG (for the HTML preview, or to check overflow)

```powershell
$dir = "$PWD\png"
New-Item -ItemType Directory -Path $dir -Force | Out-Null
$pp = New-Object -ComObject PowerPoint.Application
$pres = $pp.Presentations.Open("$PWD\docs\Agent-Insights-Final-Presentation.pptx", $true, $false, $false)
$pres.SaveCopyAs("$dir\deck.png", 18)
$pres.Close(); $pp.Quit()
```

This creates `png\deck\Slide1.PNG` … `SlideN.PNG`.
