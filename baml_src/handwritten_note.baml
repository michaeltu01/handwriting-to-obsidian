// Defining a data model.
class HandwrittenNote {
  title string
  summary string
  content string // as a Markdown
  // diagrams??
  original_note image
}

// "image" is a reserved keyword so we name the arg "img"
function ExtractNoteContent(img: image) -> string {
  client "OpenaiFallback"
  prompt #"
    {{_.role("user")}}
    Convert this handwritten note image into clean Markdown.

    Requirements:
    - Preserve headings, bullets, numbered lists, indentation, separators, and emphasis when they are visually clear.
    - Prefer structured Markdown over plain paragraphs.
    - If text is unclear, mark it as [illegible].
    - If there is a diagram or non-text sketch, insert a short placeholder like [diagram: triangle with arrows and labels].
    - Return only the Markdown transcription with no extra commentary.

    {{ img }}
  "#
}

function ExtractNoteContentFromPdf(doc: pdf) -> string {
  client "OpenaiFallback"
  prompt #"
    {{_.role("user")}}
    Convert this handwritten note PDF into clean Markdown.

    Requirements:
    - Preserve headings, bullets, numbered lists, indentation, separators, and emphasis when they are visually clear.
    - Prefer structured Markdown over plain paragraphs.
    - If text is unclear, mark it as [illegible].
    - If there is a diagram or non-text sketch, insert a short placeholder like [diagram: triangle with arrows and labels].
    - Return only the Markdown transcription with no extra commentary.

    {{ doc }}
  "#
}

test ImageTest {
  functions [ExtractNoteContent]
  args {
    img {
      file "../test_note.jpeg"
    }
  }
}

test PdfTest {
  functions [ExtractNoteContentFromPdf]
  args {
    doc {
      file "../test_note.pdf"
    }
  }
}
