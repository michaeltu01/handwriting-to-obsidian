// NOTE: UNTESTED CURRENTLY; I didn't load any credits into my Claude account yet LOL.

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
  client "CustomSonnet4"
  // Most LLM providers require images or audio to be sent as "user" messages.
  prompt #"
    {{_.role("user")}}
    This is a collection of images of a handwritten note. Extract the content of the image and convert it into text in standard Markdown format. If you encounter any freeform diagrams, instead of converting the diagram or any text in it, leave a placeholder with a description of the diagram (`diagram_description`) in the following format: [`diagram_description`].

    Return the original image(s).
    
    {{ img }}
  "#
}

// See the "testing functions" Guide for more on testing Multimodal functions
test Test {
  functions [ExtractNoteContent]
  args {
    img {
      file "../test_note.jpeg"
    }
  }
}
