import { afterEach, describe, expect, test, vi } from "vitest";

import { isFirstPromptName } from "@collector/adapters/codex/firstPrompt";
import {
  messageLine,
  metaLine,
  MINUTE,
  NOW,
  rollout,
  turnLine,
  userItemLine,
  userMessageLine,
} from "@tests/fixtures/codex";

const START = NOW - 10 * MINUTE;

/** A session file's start: its `session_meta`, a turn begun, then these lines. */
const head = (...lines: string[]) =>
  Buffer.from(rollout(metaLine(START), turnLine(START, "task_started"), ...lines));

/** A prompt as Codex records it in a legacy session: the `response_item` copy, then the event. */
const legacy = (text: string) => [messageLine(START, text), userMessageLine(START, text)];

/** The same in a paginated session, which new sessions are when Codex keeps its state database. */
const paginated = (text: string) => [messageLine(START, text), userItemLine(START, text)];

const LONG =
  "Add a retry to the demo upload job so that a failed request is tried again after a short wait.";
/** What Codex 0.170 and later save for `LONG` when its model gives no title: 59 characters and `…`. */
const LONG_CUT = "Add a retry to the demo upload job so that a failed request…";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a name Codex made from the first prompt is passed over", () => {
  test.each([
    ["legacy", legacy],
    ["paginated", paginated],
  ])("cut with …, in a %s session", (_, prompt) => {
    expect(isFirstPromptName(head(...prompt(LONG)), LONG_CUT)).toBe(true);
    // Whitespace after the … is trimmed first.
    expect(isFirstPromptName(head(...prompt(LONG)), `${LONG_CUT} \n`)).toBe(true);
  });

  test("a short prompt saved whole", () => {
    expect(
      isFirstPromptName(head(...legacy("Fix the flaky demo test")), "Fix the flaky demo test"),
    ).toBe(true);
  });

  test("Markdown that Codex takes out of the prompt is punctuation and spacing, which count for nothing", () => {
    const markdown = "## Fix the **login** timeout\n\n- check `demo-api` first\n- then the _tests_";
    expect(
      isFirstPromptName(
        head(...paginated(markdown)),
        "Fix the login timeout check demo-api first then the tests",
      ),
    ).toBe(true);
    const quoted =
      "> **Note:** the `demo` upload job\n\n1. Add a retry so that a failed request is tried again\n2. Update the tests";
    expect(
      isFirstPromptName(
        head(...legacy(quoted)),
        "Note: the demo upload job Add a retry so that a failed requ…",
      ),
    ).toBe(true);
    // A setext heading's underline, a rule and a backslash escape.
    const marks = "Fix the \\*demo\\* test\n---\n\n***\n\nthen ship";
    expect(isFirstPromptName(head(...legacy(marks)), "Fix the *demo* test then ship")).toBe(true);
  });

  test("a number in bold, which Codex keeps, is left out on both sides, as every digit is in a prompt with a letter", () => {
    expect(
      isFirstPromptName(head(...legacy("**Step 1.** Fix the build")), "Step 1. Fix the build"),
    ).toBe(true);
  });

  test("a number in code that Codex joins onto a word", () => {
    expect(isFirstPromptName(head(...legacy("Handle `404`s")), "Handle 404s")).toBe(true);
    expect(
      isFirstPromptName(
        head(...paginated("Set the retry delay to `500`ms")),
        "Set the retry delay to 500ms",
      ),
    ).toBe(true);
  });

  test("list markers in code spans, which Codex keeps", () => {
    const prompt = "Pipe it to `cat -`, then try `-`, `+` and `2)` as flags";
    expect(
      isFirstPromptName(
        head(...paginated(prompt)),
        "Pipe it to cat -, then try -, + and 2) as flags",
      ),
    ).toBe(true);
  });

  test("list-like lines in a fenced block with no language, which Codex keeps as written", () => {
    const fenced = "Why does this fail?\n```\n- expected 1\n+ received 2\n3. retried\n```";
    expect(
      isFirstPromptName(
        head(...legacy(fenced)),
        "Why does this fail? - expected 1 + received 2 3. retried",
      ),
    ).toBe(true);
  });

  test("a line that starts with 2. or 3), as a list Codex drops the number of, or in a paragraph that keeps it", () => {
    const list = "2. Update the demo docs\n3) and its tests";
    expect(isFirstPromptName(head(...paginated(list)), "Update the demo docs and its tests")).toBe(
      true,
    );
    // A list that starts at a number other than 1 cannot break into a paragraph, so Codex keeps its markers.
    const paragraph = "Two things:\n2. update the docs\n3) and the tests";
    expect(
      isFirstPromptName(
        head(...paginated(paragraph)),
        "Two things: 2. update the docs 3) and the tests",
      ),
    ).toBe(true);
  });

  test("a tight list item's text and a list nested in it, which Codex joins with no space", () => {
    const lines = legacy("- Fix login\n  - check the token");
    expect(isFirstPromptName(head(...lines), "Fix logincheck the token")).toBe(true);
  });

  test("a legacy message, whose text items Codex joins with nothing, against a title that joins them with a space", () => {
    const joined = userMessageLine(START, "Fix the flaky" + "demo test");
    expect(isFirstPromptName(head(joined), "Fix the flaky demo test")).toBe(true);
  });

  test("a cut that ends inside a number", () => {
    const prompt =
      "Move the demo upload job and its retry tests over to Node 22. Then run the suite.";
    const cut = "Move the demo upload job and its retry tests over to Node 2…";
    expect(isFirstPromptName(head(...legacy(prompt)), cut)).toBe(true);
    expect(isFirstPromptName(head(...legacy(prompt.replace("22.", "22 and"))), cut)).toBe(true);
  });

  test("a rename that differs from the prompt only in punctuation, spacing or a number, since the rule leans to passing over", () => {
    const lines = legacy("Upgrade the demo to Node 22");
    expect(isFirstPromptName(head(...lines), "Upgrade the demo to Node 24")).toBe(true);
    expect(isFirstPromptName(head(...lines), "Upgrade the demo-to Node!")).toBe(true);
  });

  test("whitespace of every kind is left out, Unicode's included, as Rust counts it", () => {
    const spaced = "  Fix\tthe\u00a0flaky demo\r\ntest\u3000now\u2028 \n";
    expect(isFirstPromptName(head(...legacy(spaced)), "Fix the flaky demo test now")).toBe(true);
  });

  test("a prompt that is not ASCII, whose characters every view keeps, curly quotes and dashes included", () => {
    const french =
      "Corrige l'échec de connexion à la base de données quand le serveur redémarre après la mise à jour";
    expect(
      isFirstPromptName(
        head(...paginated(french)),
        "Corrige l'échec de connexion à la base de données quand le…",
      ),
    ).toBe(true);
    const chinese =
      "修复演示项目中登录超时的问题，并为上传任务增加重试，失败的请求在短暂等待后再次尝试，同时更新相关的测试和文档说明，最后检查示例配置是否仍然可以正常使用并补充说明";
    expect(
      isFirstPromptName(
        head(...legacy(chinese)),
        "修复演示项目中登录超时的问题，并为上传任务增加重试，失败的请求在短暂等待后再次尝试，同时更新相关的测试和文档说明，最后…",
      ),
    ).toBe(true);
    // Codex reads Markdown with no options, so it never turns ' or -- into ’ or –.
    const typed = "Don’t break the demo – it ships";
    expect(isFirstPromptName(head(...legacy(typed)), typed)).toBe(true);
  });

  test("a prompt's JSON escapes are undone, surrogate pairs included", () => {
    const prompt =
      'Make the "café" demo 🚀 launch script résumé-safe — add a test for the path everywhere';
    // A writer that escapes everything but ASCII, as Codex does not, writes the same prompt so.
    const escaped = userMessageLine(START, prompt)
      .replace("🚀", "\\ud83d\\ude80")
      .replace("—", "\\u2014")
      .replaceAll("é", "\\u00E9");
    expect(escaped).toContain('\\"caf\\u00E9\\" demo \\ud83d\\ude80');
    expect(
      isFirstPromptName(
        head(messageLine(START, prompt), escaped),
        'Make the "café" demo 🚀 launch script résumé-safe — add a te…',
      ),
    ).toBe(true);
    // Half a surrogate pair alone, which JSON can hold and Codex never writes, stands for U+FFFD.
    expect(isFirstPromptName(head(userMessageLine(START, "Fix \ud800 now")), "Fix � now")).toBe(
      true,
    );
  });

  test("only the request after an editor's context counts, as for Codex's title", () => {
    const prompt =
      "# Context from my IDE setup:\n\n## Open tabs:\n- demo.ts\n\n## My request for Codex:\nFix the flaky demo test";
    expect(isFirstPromptName(head(...legacy(prompt)), "Fix the flaky demo test")).toBe(true);
  });

  test("only what follows the last of two editor's context markers counts, as Codex splits at the last", () => {
    const prompt =
      "# Context from my IDE setup:\n\n## My request for Codex:\nUpdate the old docs\n\n## My request for Codex:\nFix the flaky demo test";
    const lines = paginated(prompt);
    expect(isFirstPromptName(head(...lines), "Fix the flaky demo test")).toBe(true);
    expect(isFirstPromptName(head(...lines), "Update the old docs")).toBe(false);
    expect(
      isFirstPromptName(
        head(...lines),
        "Update the old docs ## My request for Codex: Fix the flaky demo test",
      ),
    ).toBe(false);
  });

  test("HTML's open and closing tags, which Codex takes out, are left out of both", () => {
    expect(
      isFirstPromptName(head(...legacy("Make useState<number>() typed")), "Make useState() typed"),
    ).toBe(true);
    expect(isFirstPromptName(head(...paginated("Use Option<T> here")), "Use Option here")).toBe(
      true,
    );
    expect(
      isFirstPromptName(head(...legacy("Fix the </div> closing tag")), "Fix the closing tag"),
    ).toBe(true);
    expect(
      isFirstPromptName(
        head(...legacy("...use the new <Header /> component")),
        "...use the new component",
      ),
    ).toBe(true);
    // Codex keeps the text between two tags.
    expect(
      isFirstPromptName(
        head(...legacy("Fix the <kbd>Enter</kbd> key in the demo")),
        "Fix the Enter key in the demo",
      ),
    ).toBe(true);
    // Attributes, quoted or not, and a line ending within the tag.
    expect(
      isFirstPromptName(
        head(...legacy("Fix the <a href=\"/demo\" data-id=4\n  title='Demo'>demo link</a>")),
        "Fix the demo link",
      ),
    ).toBe(true);
  });

  test("a tag in code, which Codex keeps, is left out of the name too", () => {
    expect(isFirstPromptName(head(...legacy("Use `Vec<u8>` here")), "Use Vec<u8> here")).toBe(true);
  });

  test("a tag name with a digit, and a closing tag with whitespace before its >, as CommonMark allows", () => {
    expect(isFirstPromptName(head(...legacy("Fix the <h1> title")), "Fix the title")).toBe(true);
    expect(isFirstPromptName(head(...legacy("Fix the </h1 > title")), "Fix the title")).toBe(true);
  });

  test("tags are left out again while that leaves out more, as one left out can make another", () => {
    // Codex takes out <T> alone, and saves <Mutex>.
    expect(
      isFirstPromptName(head(...legacy("Use Arc<Mutex<T>> here")), "Use Arc<Mutex> here"),
    ).toBe(true);
    // With a tag in code too, so that the name with its tags kept is not the prompt either.
    expect(
      isFirstPromptName(
        head(...legacy("Use `<b>` tags with Arc<Mutex<T>> here")),
        "Use <b> tags with Arc<Mutex> here",
      ),
    ).toBe(true);
    // A JSX prop: Codex takes out <Home />, which leaves a tag it did not see.
    expect(
      isFirstPromptName(
        head(...paginated('Fix <Route path="/" element={<Home />} /> in the demo router')),
        'Fix <Route path="/" element={} /> in the demo router',
      ),
    ).toBe(true);
  });

  test("HTML comments, processing instructions, declarations and CDATA, which Codex takes out as it takes out tags", () => {
    const prompt =
      "Fix the <!-- old --> demo <?php echo 1; ?> upload <!DOCTYPE html> job <![CDATA[x]]> now";
    expect(isFirstPromptName(head(...legacy(prompt)), "Fix the demo upload job now")).toBe(true);
  });

  test("code that Codex joins into what reads as a tag, compared with the name's tags kept", () => {
    expect(
      isFirstPromptName(head(...legacy("Fix `i<n` and `j>0` checks")), "Fix i<n and j>0 checks"),
    ).toBe(true);
  });

  test.each([
    [
      "Why does the loop panic when i<n and `Vec<T>` len > 0",
      "Why does the loop panic when i<n and Vec<T> len > 0",
    ],
    [
      "Fix the bounds check: i<n fails for `Vec<u8>` when len > 1",
      "Fix the bounds check: i<n fails for Vec<u8> when len > 1",
    ],
    // The prompt's escapes are kept, as Codex keeps them in code.
    [
      "Why does the regex `\\<x\\>` fail when i<n and `Vec<T>` len > 0",
      "Why does the regex \\<x\\> fail when i<n and Vec<T> len > 0",
    ],
    // The prompt's tags are left out once too, and only its tags.
    ["Fix i<n when `Option<Box<T>>` is > 0", "Fix i<n when Option<Box<T>> is > 0"],
    [
      "Fix the `<!-- todo -->` comment when i<n and `Vec<T>` len > 0",
      "Fix the <!-- todo --> comment when i<n and Vec<T> len > 0",
    ],
    ["returns `<!foo\\`</b>` in vim", "returns <!foo\\` in vim"],
  ])(
    "a < in text and a > after a tag in code, which leaving tags out again joins, compared with tags left out once: %j",
    (prompt, title) => {
      expect(isFirstPromptName(head(...legacy(prompt)), title)).toBe(true);
      expect(isFirstPromptName(head(...paginated(prompt)), title)).toBe(true);
    },
  );

  test("a prompt that is a tag in code, which leaving tags out leaves nothing of, compared with its tags kept", () => {
    expect(isFirstPromptName(head(...legacy("`<div>`")), "<div>")).toBe(true);
  });

  test("the view is the prompt's once its tags and fence lines are left out", () => {
    expect(isFirstPromptName(head(...legacy("<b>4521</b>")), "4521")).toBe(true);
    expect(isFirstPromptName(head(...paginated("```ts\n4521\n```")), "4521")).toBe(true);
  });

  test("a backslash escape, which Codex undoes, is undone before tags are left out", () => {
    expect(
      isFirstPromptName(head(...legacy("Use \\<T\\> in the docs")), "Use <T> in the docs"),
    ).toBe(true);
    expect(
      isFirstPromptName(
        head(...paginated("Use \\<T\\> and `<b>` in the docs")),
        "Use <T> and <b> in the docs",
      ),
    ).toBe(true);
    // In a prompt of marks alone, the marks count.
    expect(isFirstPromptName(head(...legacy("\\*\\*\\*")), "***")).toBe(true);
  });

  test("a line that opens or closes a fenced code block, whose fence and language Codex takes out", () => {
    expect(
      isFirstPromptName(
        head(...legacy("Fix this:\n```ts\nconst x = 1\n```")),
        "Fix this: const x = 1",
      ),
    ).toBe(true);
    expect(
      isFirstPromptName(
        head(...paginated("Fix this:\n~~~ts\nconst x = 1\n~~~")),
        "Fix this: const x = 1",
      ),
    ).toBe(true);
    expect(
      isFirstPromptName(head(...legacy("```ts\nconst demo = load()\n```")), "const demo = load()"),
    ).toBe(true);
  });

  test("fences paired as CommonMark pairs them: the closing one the same mark, as many or more, then only spaces or tabs", () => {
    // A shorter fence inside is the block's text.
    expect(
      isFirstPromptName(head(...legacy("````\nconst a = 1\n```\n````")), "const a = 1 ```"),
    ).toBe(true);
    expect(
      isFirstPromptName(
        head(...paginated("~~~ts\nconst a = 1\n~~~~ \nthen ship")),
        "const a = 1 then ship",
      ),
    ).toBe(true);
    // So a shorter one does not close the block, and a line after it with a language opens none.
    expect(
      isFirstPromptName(
        head(...legacy("````\nRun it like this:\n```\nnpm test\n```sh\n````")),
        "Run it like this: ``` npm test ```sh",
      ),
    ).toBe(true);
    // A fence followed by text closes nothing, so the line is the block's text.
    expect(
      isFirstPromptName(
        head(...legacy("```\nnpm run build\n``` fails on CI")),
        "npm run build ``` fails on CI",
      ),
    ).toBe(true);
  });

  test("a tilde line inside a block of backticks, which does not close it, and two backticks, which open no fence", () => {
    // So the next line, with a language, opens none either.
    expect(
      isFirstPromptName(
        head(...legacy("```\nconst a = 1\n~~~\n```sh\n```")),
        "const a = 1 ~~~ ```sh",
      ),
    ).toBe(true);
    // Codex reads two backticks and what follows as a code span, and keeps its text.
    expect(isFirstPromptName(head(...paginated("``ts\nnpm test\n``")), "ts npm test")).toBe(true);
  });

  test("backticks with a backtick after them on the line are a code span, which Codex keeps, not a fence", () => {
    expect(
      isFirstPromptName(head(...legacy("```npm test``` fails on CI")), "npm test fails on CI"),
    ).toBe(true);
  });

  describe("a copy of the prompt with more of what Codex takes out or changes left out or undone", () => {
    test.each([
      [
        "an HTML block of raw text, through its closing tag",
        "Refactor the demo\n<style>\n.banner { color: red }\n</style>",
        "Refactor the demo",
      ],
      [
        "an HTML block of raw text that ends on its first line",
        "Fix the demo\n<style>.banner { color: red }</style>\n\nthen ship",
        "Fix the demo then ship",
      ],
      [
        "an HTML block that opens with a block tag, to a blank line",
        'Fix the demo\n<table class="x">\n  <tr><td>cache</td></tr>\n</table>',
        "Fix the demo",
      ],
      [
        "an HTML block of one tag on its line, to a blank line",
        "<Button>\n  save\n</Button>\n\nFix the demo button",
        "Fix the demo button",
      ],
      [
        "an HTML block that opens with a block tag's closing tag",
        "Fix the demo\n</div>\nnote",
        "Fix the demo",
      ],
      [
        "an HTML block of one tag after an ATX heading, which ends a paragraph",
        "## Fix the demo\n<Button>\n  save\n</Button>",
        "Fix the demo",
      ],
      [
        "an HTML block after a list item's marker, the rest of its line",
        "- <div>note</div>\n- Fix the demo",
        "Fix the demo",
      ],
      [
        "a tag after a list item's marker that follows a paragraph, so that one tag on the next line starts a block",
        "Fix the demo:\n- <Button />\n<Card>\n  note\n</Card>",
        "Fix the demo:",
      ],
      ["an image's destination", "![screenshot of the demo](shot.png)", "screenshot of the demo"],
      [
        "a link's destination in angle brackets",
        "[the docs](<docs/the demo.md>) for the demo",
        "the docs for the demo",
      ],
      [
        "a link's destination and title",
        'Fix [the upload bug](https://example.com/issues/1 "Issue 1") in the demo',
        "Fix the upload bug in the demo",
      ],
      [
        "a link's title in parentheses",
        "[the docs](https://example.com/docs (Docs)) for the demo",
        "the docs for the demo",
      ],
      [
        "a reference's label and its definition",
        'Follow [the guide][g] for the demo\n\n[g]: https://example.com/guide "Guide"',
        "Follow the guide for the demo",
      ],
      [
        "a definition with its title in parentheses",
        "Follow [the guide][g] for the demo\n\n[g]: https://example.com/guide (Guide)",
        "Follow the guide for the demo",
      ],
      [
        "a reference's label in another case than its definition's",
        "Follow [the guide][G] for the demo\n\n[g]: https://example.com/guide",
        "Follow the guide for the demo",
      ],
      [
        "a reference's label spaced otherwise than its definition's",
        "Follow [the guide][demo  guide] for the demo\n\n[ Demo guide ]: https://example.com/guide",
        "Follow the guide for the demo",
      ],
      [
        "collapsed references to labels the prompt defines, one after another",
        "Fix the badges ![build][][coverage][] in the README\n\n[build]: https://example.com/build.svg\n[coverage]: https://example.com/coverage.svg",
        "Fix the badges buildcoverage in the README",
      ],
      ["an empty label after marks that define no label", "[!][]\n\n\n[x]: /u", "[!][]"],
      [
        "a definition after a thematic break, which ends a paragraph",
        "Fix the demo\n***\n[g]: https://example.com/guide",
        "Fix the demo",
      ],
      [
        "a fence's language after a list item's marker",
        "1. Run:\n    ```sh\n    npm test\n    ```",
        "Run:npm test",
      ],
      [
        "a fence's language after a block quote's marker",
        "> ```py\n> print(demo)\n> ```",
        "print(demo)",
      ],
      [
        "a fence's language in an indented block's text, after a line that ended the list item and its block for Codex",
        "- Install:\n  ```\n  npm ci\nthen\n  ```bash\n  npm test\n  ```",
        "Install:npm ci then npm test",
      ],
      [
        "that, then a fence and its language after a block quote's marker",
        "- Install:\n  ```\n  npm ci\nthen\n  ```bash\n  npm test\n  ```\n\n> ```py\n> print(1)\n> ```",
        "Install:npm ci then npm test print(1)",
      ],
      [
        "named entities",
        "&copy; Fix the caf&eacute; demo &mdash; now",
        "© Fix the café demo — now",
      ],
      ["numeric entities", "Fix the demo &#x27;upload&#39; job", "Fix the demo 'upload' job"],
      [
        "a numeric entity that is no character, as U+FFFD",
        "Fix the demo &#0; job",
        "Fix the demo \uFFFD job",
      ],
      [
        "an entity between backticks that a fenced block keeps from pairing",
        "Run `npm ci\n```\nnpm run build\n```\nthen fix the caf&eacute; page` here",
        "Run `npm ci npm run build then fix the café page` here",
      ],
      [
        "a link and entities at once",
        "Fix [the bug](https://example.com/1) &amp; the caf&eacute; demo",
        "Fix the bug & the café demo",
      ],
      [
        "a link and an HTML block at once",
        "Fix [the bug](https://example.com/1) in the demo\n<div>\nnote\n</div>",
        "Fix the bug in the demo",
      ],
      [
        "an HTML block and a definition at once",
        "Fix the demo\n<div>\nnote\n</div>\n\n[g]: https://example.com/guide",
        "Fix the demo",
      ],
      [
        "a fence's language after a list item's marker and a link at once",
        "1. Run:\n    ```sh\n    npm test\n    ```\n\nSee [the docs](https://example.com/docs)",
        "Run:npm test See the docs",
      ],
    ])("%s", (_, prompt, title) => {
      expect(isFirstPromptName(head(...legacy(prompt)), title)).toBe(true);
      expect(isFirstPromptName(head(...paginated(prompt)), title)).toBe(true);
    });

    test("a ]( that opens no link, which Codex keeps, against the prompt with only its entities decoded", () => {
      expect(
        isFirstPromptName(
          head(...legacy("Map ](x) to &lt;x&gt; in the demo")),
          "Map ](x) to <x> in the demo",
        ),
      ).toBe(true);
    });

    test("a code span, whose entities and link marks Codex keeps, as the copies keep them", () => {
      expect(
        isFirstPromptName(
          head(
            ...legacy("Write `&amp;` as [the escape](https://example.com/1) &mdash; in the demo"),
          ),
          "Write &amp; as the escape — in the demo",
        ),
      ).toBe(true);
      // A fenced block's text is code too.
      expect(
        isFirstPromptName(
          head(...paginated("```html\n&amp;\n```\nFix the caf&eacute; demo")),
          "&amp; Fix the café demo",
        ),
      ).toBe(true);
      // In code a backslash is text, so the next run as long closes the span.
      expect(
        isFirstPromptName(
          head(...legacy("Print `\\` then &copy; and `&amp;`")),
          "Print \\ then © and &amp;",
        ),
      ).toBe(true);
      // Outside code it escapes the backtick after it, which then opens no span, so the next run does.
      expect(
        isFirstPromptName(
          head(...paginated("Use \\`&amp;` and `&copy;` here")),
          "Use `&and©` here",
        ),
      ).toBe(true);
    });
  });

  test.each([
    [
      "Fix the regex `\\<\\w+\\>` so it matches whole words",
      "Fix the regex \\<\\w+\\> so it matches whole words",
    ],
    ["Why does `grep '\\<foo\\>' file` miss lines?", "Why does grep '\\<foo\\>' file miss lines?"],
    [
      "In vim, `:%s/\\<foo\\>/bar/g` replaces only whole words",
      "In vim, :%s/\\<foo\\>/bar/g replaces only whole words",
    ],
    ['Why does `"<a href=\\"x\\">"` fail', 'Why does "<a href=\\"x\\">" fail'],
    [
      'Fix:\n```json\n{"html": "<p class=\\"lead\\">Hello</p>"}\n```',
      'Fix: {"html": "<p class=\\"lead\\">Hello</p>"}',
    ],
    [
      'The API returns `{"body":"<p class=\\"x\\">Hi</p>"}`',
      'The API returns {"body":"<p class=\\"x\\">Hi</p>"}',
    ],
    ["```\n\\*\n```", "\\*"],
    ["Use `\\<br\\>` not `<br>`", "Use \\<br\\> not <br>"],
    [
      "```\n:%s/\\<old\\>/new/g\n```\nwhy does this not replace",
      ":%s/\\<old\\>/new/g why does this not replace",
    ],
    ['```html\n<a href=\\"/x\\">go</a>\n```', '<a href=\\"/x\\">go</a>'],
    // Indented code, which only the prompt with its escapes kept keeps as Codex does.
    ["Fix this:\n\n    \\<b\\>bold", "Fix this: \\<b\\>bold"],
  ])(
    "a backslash in code, which Codex keeps, compared with the prompt's escapes kept: %j",
    (prompt, title) => {
      expect(isFirstPromptName(head(...legacy(prompt)), title)).toBe(true);
    },
  );

  test.each([
    [
      "Fix the ` typo.\n\nSee [`config.ts`](https://example.com/docs)",
      "Fix the ` typo. See config.ts",
    ],
    ["# Escape the ` key\nsee [`README`](docs/README.md) too", "Escape the ` key see README too"],
    ["- Escape the ` key\n- Update [`README`](docs/README.md)", "Escape the ` key Update README"],
    ["Run:\n\n    echo `\n\nthen fix [`a.ts`](src/a.ts)", "Run: echo ` then fix a.ts"],
    ["Fix the ` typo.\n\n![`shot`](img/shot.png)", "Fix the ` typo. shot"],
    [
      "Fix the ` typo.\n\nSee [`config.ts`][cfg]\n\n[cfg]: https://example.com",
      "Fix the ` typo. See config.ts",
    ],
    ["Fix <https://example.com/`a> and [`b`](src/b.ts)", "Fix https://example.com/`a and b"],
    ['Fix <b title="`"> and [`b`](src/b.ts)', "Fix and b"],
  ])("a link whose `[` a lone backtick before it seems to put in code: %j", (prompt, title) => {
    expect(isFirstPromptName(head(...legacy(prompt)), title)).toBe(true);
  });

  test.each([
    ["Fix ](x) in [the docs](/docs)", "Fix ](x) in the docs"],
    ["Fix \\[a](x) in [the docs](/docs)", "Fix [a](x) in the docs"],
    ["Fix a](x) and b](y) in ![the](/icon) docs", "Fix a](x) and b](y) in the docs"],
    ["Fix [a] b](x) in [the docs](/docs)", "Fix [a] b](x) in the docs"],
    ["Fix &lt;x>](y) in [the docs](/docs)", "Fix <x>](y) in the docs"],
    ["Fix ][g] in [the docs][g]\n\n[g]: https://example.com", "Fix ]g in the docs"],
  ])("what follows a `]` with no `[` to pair with, which Codex keeps: %j", (prompt, title) => {
    expect(isFirstPromptName(head(...legacy(prompt)), title)).toBe(true);
  });

  test("the prompt's 2,000th character is in its excerpt and the 2,001st is not, counted by characters, not bytes", () => {
    // U+3000, an ideographic space, is whitespace of three bytes, which Codex keeps out of the title.
    const within = `Fix the demo${"\u3000".repeat(1987)}x`;
    const past = `Fix the demo${"\u3000".repeat(1988)}x`;
    expect([...within]).toHaveLength(2000);
    expect(isFirstPromptName(head(...legacy(within)), "Fix the demo x")).toBe(true);
    expect(isFirstPromptName(head(...legacy(past)), "Fix the demo")).toBe(true);
    expect(isFirstPromptName(head(...legacy(past)), "Fix the demo x")).toBe(false);
  });

  test("the prompt is trimmed before it is cut to 2,000 characters, as Codex trims it first", () => {
    const prompt = `${"  \n".repeat(4)}Fix the demo${"　".repeat(1987)}x`;
    expect([...prompt.trim()]).toHaveLength(2000);
    expect(isFirstPromptName(head(...legacy(prompt)), "Fix the demo x")).toBe(true);
  });

  test("a prompt of more than 2,000 characters, cut to them as Codex cuts it before reading it", () => {
    const prompt = `Fix the demo${"\n".repeat(2100)}then update the docs`;
    expect(isFirstPromptName(head(...legacy(prompt)), "Fix the demo")).toBe(true);
    expect(isFirstPromptName(head(...paginated(prompt)), "Fix the demo then update the docs")).toBe(
      false,
    );
  });

  test("a prompt that itself ends with …, saved whole", () => {
    expect(isFirstPromptName(head(...legacy("1, 2, 3…")), "1, 2, 3…")).toBe(true);
    expect(isFirstPromptName(head(...legacy("…")), "…")).toBe(true);
  });

  test("a paginated prompt's text items are joined by a space, and its other items skipped", () => {
    const line = userItemLine(
      START,
      "Fix the flaky",
      { type: "image", image_url: "data:image/png;base64,AAAA" },
      // An item of another kind is skipped, even one with a text of its own.
      { type: "mention", name: "demo", path: "app://demo", text: "@demo" },
      "demo test",
    );
    expect(isFirstPromptName(head(line), "Fix the flaky demo test")).toBe(true);
  });

  test("a prompt with no letter, compared by its digits, or with no digit either, by all but its whitespace", () => {
    expect(isFirstPromptName(head(...legacy("4521")), "4521")).toBe(true);
    expect(isFirstPromptName(head(...paginated("#410")), "#410")).toBe(true);
    expect(isFirstPromptName(head(...legacy("2026-11-23")), "2026-11-23")).toBe(true);
    expect(isFirstPromptName(head(...legacy("???")), "???")).toBe(true);
    // Codex takes out a code span's marks, which a prompt with digits leaves out too.
    expect(isFirstPromptName(head(...legacy("`4521`")), "4521")).toBe(true);
  });

  test("a long list of numbers, cut with …", () => {
    // Codex saves a list's items with a space between them, and drops their marks.
    const list =
      "- 4521\n- 4522\n- 4523\n- 4524\n- 4525\n- 4526\n- 4527\n- 4528\n- 4529\n- 4530\n- 4531\n- 4532\n- 4533\n- 4534\n- 4535";
    expect(
      isFirstPromptName(
        head(...paginated(list)),
        "4521 4522 4523 4524 4525 4526 4527 4528 4529 4530 4531 4532…",
      ),
    ).toBe(true);
    // Numbered, as Codex drops the numbers too.
    const numbered = Array.from({ length: 15 }, (_, index) => `${index + 1}. ${4521 + index}`);
    expect(
      isFirstPromptName(
        head(...legacy(numbered.join("\n"))),
        "4521 4522 4523 4524 4525 4526 4527 4528 4529 4530 4531 4532…",
      ),
    ).toBe(true);
  });

  test("a list of digits or marks alone, compared with its markers left out too, as Codex drops them", () => {
    expect(isFirstPromptName(head(...legacy("1. 4521\n2. 4522\n3. 4523")), "4521 4522 4523")).toBe(
      true,
    );
    expect(isFirstPromptName(head(...legacy("1. 42")), "42")).toBe(true);
    expect(isFirstPromptName(head(...paginated("3) 7")), "7")).toBe(true);
    expect(isFirstPromptName(head(...legacy("- ???\n- ?!?")), "??? ?!?")).toBe(true);
    // Without its markers, a list of marks has no digit, and takes the view of all but whitespace.
    expect(isFirstPromptName(head(...legacy("1. ???\n2. ?!?")), "??? ?!?")).toBe(true);
    // The prompt as written still counts.
    expect(isFirstPromptName(head(...legacy("1. 42")), "1. 42")).toBe(true);
  });

  test("a list marker after up to three spaces, and on the first line after any, as Codex trims the prompt first", () => {
    expect(isFirstPromptName(head(...legacy("   1. 42")), "42")).toBe(true);
    expect(isFirstPromptName(head(...legacy("    1. 42")), "42")).toBe(true);
    expect(isFirstPromptName(head(...paginated("\n    1. 42")), "42")).toBe(true);
    // On a later line, four spaces make code, whose marker Codex keeps.
    expect(isFirstPromptName(head(...legacy("4521\n\n    1. 42")), "4521 1. 42")).toBe(true);
  });

  describe("a name cut with … after 58 or 59 characters whose letters come in order in the prompt, past text Codex takes out", () => {
    test.each([
      [
        "an HTML block",
        '<div class="note">\nKeep the old banner for now\n</div>\n\nAdd a retry to the demo upload job so that a failed request is tried again after a short wait.',
        "Add a retry to the demo upload job so that a failed request…",
      ],
      [
        "an HTML block, with 58 characters before the … as Codex trims a space",
        '<div class="note">\nKeep the old banner for now\n</div>\n\nAdd a retry to the demo upload job so that a failed reques t is tried again.',
        "Add a retry to the demo upload job so that a failed reques…",
      ],
      [
        "a nested generic the cut ends in",
        "Keep the retry state of the demo upload job in one Arc<Mutex<RetryState>> for now",
        "Keep the retry state of the demo upload job in one Arc<Mute…",
      ],
      [
        "a fence after a list item's marker",
        "- ```sh\n  npm run build\n  ```\n- Then add a retry to the demo upload job so that a failed request is tried again.",
        "npm run build Then add a retry to the demo upload job so th…",
      ],
      [
        "a fence in a block quote",
        "> ```ts\n> const retries = 3\n> ```\n\nAdd a retry to the demo upload job so that a failed request is tried again after a short wait.",
        "const retries = 3 Add a retry to the demo upload job so tha…",
      ],
      [
        "a reference definition",
        "[guide]: https://example.com/demo-guide\n\nFollow the [guide] to add a retry to the demo upload job so that a failed request is tried again.",
        "Follow the guide to add a retry to the demo upload job so t…",
      ],
      [
        "a link's address",
        "Fix [the upload bug](https://example.com/issues/1) in the demo job so that a failed request is tried again after a short wait.",
        "Fix the upload bug in the demo job so that a failed request…",
      ],
      [
        "a tag in code the cut ends in",
        'Make the demo upload job print `<a href="https://example.com/demo">` in its retry log',
        'Make the demo upload job print <a href="https://example.com…',
      ],
      [
        "an HTML block in a block quote, with 58 characters before the … and more bytes",
        "> <div>\n> Garde l'ancienne bannière\n> </div>\n\nCorrige l'échec de connexion à la base de données quand le serveur redémarre après la mise à jour",
        "Corrige l'échec de connexion à la base de données quand le…",
      ],
      [
        "an entity Codex turns into a character past ASCII, in order once the prompt's entities are decoded",
        "> <div>\n> note\n> </div>\n\nMake the caf&eacute; demo upload job try a failed request again after a short wait",
        "Make the café demo upload job try a failed request again af…",
      ],
    ])("%s", (_, prompt, title) => {
      expect([58, 59]).toContain([...title.slice(0, -1)].length);
      expect(isFirstPromptName(head(...legacy(prompt)), title)).toBe(true);
      expect(isFirstPromptName(head(...paginated(prompt)), `${title} `)).toBe(true);
    });

    test("characters are counted, not bytes", () => {
      const title = "Corrige l'échec de connexion à la base de données quand le…";
      // 58 characters before the …, but 61 bytes, more than any cut leaves.
      expect([...title.slice(0, -1)]).toHaveLength(58);
      expect(Buffer.byteLength(title.slice(0, -1))).toBe(61);
      const prompt =
        "> <div>\n> Garde l'ancienne bannière\n> </div>\n\nCorrige l'échec de connexion à la base de données quand le serveur redémarre après la mise à jour";
      expect(isFirstPromptName(head(...paginated(prompt)), title)).toBe(true);
    });
  });

  test("a first prompt of images or whitespace alone starts no title, so the next prompt is the one compared", () => {
    const images = userItemLine(START, { type: "local_image", path: "/Users/example/demo.png" });
    expect(
      isFirstPromptName(
        head(images, ...paginated("Fix the flaky demo test")),
        "Fix the flaky demo test",
      ),
    ).toBe(true);
    expect(
      isFirstPromptName(head(userMessageLine(START, " \n "), ...legacy("Fix it")), "Fix it"),
    ).toBe(true);
  });

  test("the bytes of the prompt are never turned into text or parsed", () => {
    const named: [Buffer, string][] = [
      [head(...paginated(`${LONG} \\u00e9 ✓`)), LONG_CUT],
      [head(...legacy('Fix the <a href="/demo" data-id=4>demo link</a>')), "Fix the demo link"],
      [head(...paginated("Fix this:\n```ts\nconst x = 1\n```")), "Fix this: const x = 1"],
      [head(...legacy("1. Add a retry\n2. Update the tests")), "Add a retry Update the tests"],
      [head(...paginated("1. 4521\n2. 4522")), "4521 4522"],
      // The name with its HTML kept, then both with it kept.
      [head(...legacy("Fix `i<n` and `j>0` checks")), "Fix i<n and j>0 checks"],
      [head(...legacy("`<div>`")), "<div>"],
      // Both with their tags left out once.
      [
        head(...paginated("Why does the loop panic when i<n and `Vec<T>` len > 0")),
        "Why does the loop panic when i<n and Vec<T> len > 0",
      ],
      // A name cut with …, by its letters in order, in the prompt and with its entities decoded.
      [
        head(
          ...legacy(
            "> <div>\n> note\n> </div>\n\nMake the caf&eacute; demo upload job try a failed request again after a short wait",
          ),
        ),
        "Make the café demo upload job try a failed request again af…",
      ],
      // The copies: escapes kept, entities decoded, HTML blocks, links and fence languages left out, and all.
      [head(...legacy("Use `\\<br\\>` not `<br>`")), "Use \\<br\\> not <br>"],
      [head(...paginated("Fix the demo &#x27;upload&#39; job")), "Fix the demo 'upload' job"],
      [
        head(...legacy("<Button>\n  save\n</Button>\n\nFix the demo button")),
        "Fix the demo button",
      ],
      [
        head(
          ...legacy('Follow [the guide][g] for the demo\n\n[g]: https://example.com/guide "Guide"'),
        ),
        "Follow the guide for the demo",
      ],
      [head(...paginated("> ```py\n> print(demo)\n> ```")), "print(demo)"],
      [
        head(...legacy("Fix [the bug](https://example.com/1) &amp; the caf&eacute; demo")),
        "Fix the bug & the café demo",
      ],
      [
        head(...paginated("- Install:\n  ```\n  npm ci\nthen\n  ```bash\n  npm test\n  ```")),
        "Install:npm ci then npm test",
      ],
    ];
    const toString = vi.spyOn(Buffer.prototype, "toString");
    const parse = vi.spyOn(JSON, "parse");
    const fromCodePoint = vi.spyOn(String, "fromCodePoint");
    const fromCharCode = vi.spyOn(String, "fromCharCode");
    const decode = vi.spyOn(TextDecoder.prototype, "decode");
    for (const [bytes, name] of named) expect(isFirstPromptName(bytes, name)).toBe(true);
    for (const spy of [toString, parse, fromCodePoint, fromCharCode, decode]) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});

describe("a name that is not the first prompt, whole or cut with …, is kept", () => {
  test("a rename that starts like the prompt, but is neither all of it nor cut with …, or is longer", () => {
    const lines = legacy("Fix the flaky demo test in the upload job");
    expect(isFirstPromptName(head(...lines), "Fix the flaky demo test")).toBe(false);
    expect(
      isFirstPromptName(head(...lines), "Fix the flaky demo test in the upload job, then ship"),
    ).toBe(false);
  });

  test("a model's title, even one that echoes the prompt's first words, cut at 36 characters with no …", () => {
    const lines = paginated(LONG);
    expect(isFirstPromptName(head(...lines), "Retry failed demo uploads")).toBe(false);
    expect(isFirstPromptName(head(...lines), "Add a retry to the demo upload job s")).toBe(false);
  });

  test("a name made of some of the prompt's words", () => {
    const lines = legacy("Fix the login bug");
    expect(isFirstPromptName(head(...lines), "Fix bug")).toBe(false);
    expect(isFirstPromptName(head(...lines), "Fix bug…")).toBe(false);
  });

  test("a name cut with … whose letters come in order in the prompt, but with fewer than 58 characters before the …", () => {
    const name = "Add a retry so failed requests…";
    expect([...name.slice(0, -1)]).toHaveLength(30);
    expect(isFirstPromptName(head(...legacy(LONG)), name)).toBe(false);
  });

  test.each([57, 60])(
    "a name cut with … whose letters come in order in the prompt, with %i characters before the …",
    (length) => {
      const name = `${"Add a retry to the demo upload job so a failed request is tried again".slice(0, length)}…`;
      expect([...name.slice(0, -1)]).toHaveLength(length);
      expect(isFirstPromptName(head(...legacy(LONG)), name)).toBe(false);
    },
  );

  test("a name of the prompt's first 59 characters with no …", () => {
    const name = LONG_CUT.slice(0, -1);
    expect([...name]).toHaveLength(59);
    expect(isFirstPromptName(head(...paginated(LONG)), name)).toBe(false);
  });

  test("a name cut with … whose letters come in order only past the prompt's first 2,000 characters", () => {
    const prompt = `Fix it${"\n".repeat(2100)}${LONG}`;
    expect(isFirstPromptName(head(...legacy(prompt)), LONG_CUT)).toBe(false);
    expect(isFirstPromptName(head(...legacy(prompt)), "Fix it")).toBe(true);
  });

  test("a name of 59 characters and … whose letters do not come in order in the prompt", () => {
    const name = "A failed request is tried again after a short wait in the d…";
    expect([...name.slice(0, -1)]).toHaveLength(59);
    expect(isFirstPromptName(head(...paginated(LONG)), name)).toBe(false);
  });

  test("a line indented four spaces or more, which is code whose list marker Codex keeps, or a marker of ten digits", () => {
    expect(isFirstPromptName(head(...legacy("4521\n\n    1. 42")), "4521 42")).toBe(false);
    expect(isFirstPromptName(head(...legacy("1234567890. 42")), "42")).toBe(false);
  });

  test("a name that differs in case, or starts part-way into the prompt", () => {
    const lines = legacy("Fix the flaky demo test");
    expect(isFirstPromptName(head(...lines), "fix the flaky demo test")).toBe(false);
    expect(isFirstPromptName(head(...lines), "flaky demo test")).toBe(false);
  });

  test("a name that is only the prompt's start with no …, is longer, or differs in case", () => {
    const readme = legacy("Fix the README");
    expect(isFirstPromptName(head(...readme), "Fix the")).toBe(false);
    expect(isFirstPromptName(head(...readme), "Fix the readme")).toBe(false);
    expect(isFirstPromptName(head(...legacy("Fix the")), "Fix the README")).toBe(false);
    expect(isFirstPromptName(head(...legacy("Fix the readme")), "Fix the README")).toBe(false);
  });

  test("marks alone against a prompt with a letter, or a letter against a prompt of marks", () => {
    expect(isFirstPromptName(head(...legacy("Fix ???")), "???")).toBe(false);
    expect(isFirstPromptName(head(...legacy("???")), "Fix ???")).toBe(false);
  });

  test("a name that differs from the prompt once tags are left out, or lacks text that only looks like a tag", () => {
    // Codex takes out a tag whole, and keeps what is between two.
    expect(isFirstPromptName(head(...legacy("Use Option<T> here")), "Use Option T here")).toBe(
      false,
    );
    expect(
      isFirstPromptName(
        head(...legacy("Fix the <kbd>Enter</kbd> key in the demo")),
        "Fix the key in the demo",
      ),
    ).toBe(false);
    // A tag name cannot be followed by `=`, so Codex keeps `<a=b>`, and so does the comparison.
    expect(isFirstPromptName(head(...legacy("Set <a=b> in the config")), "Set in the config")).toBe(
      false,
    );
  });

  test("a name that is empty in the view its prompt takes: … alone, marks, or digits against a prompt with a letter", () => {
    const lines = legacy("2026 plan: write the demo notes");
    expect(isFirstPromptName(head(...lines), "…")).toBe(false);
    expect(isFirstPromptName(head(...lines), "**")).toBe(false);
    expect(isFirstPromptName(head(...lines), "2026")).toBe(false);
    expect(isFirstPromptName(head(...lines), "2026…")).toBe(false);
  });

  test("a curly quote or dash where the prompt has a straight one, which Codex, reading Markdown with no options, never makes", () => {
    const lines = legacy("Don't break the demo -- it ships");
    expect(isFirstPromptName(head(...lines), "Don’t break the demo – it ships")).toBe(false);
  });

  test("a prompt with no letter, against a name that differs in a digit, or, with no digit either, in a mark", () => {
    expect(isFirstPromptName(head(...legacy("4521")), "4522")).toBe(false);
    expect(isFirstPromptName(head(...legacy("4521")), "Fix 4521")).toBe(false);
    expect(isFirstPromptName(head(...legacy("???")), "?!?")).toBe(false);
  });

  test("the first prompt is the one compared, not a later one", () => {
    const lines = [...legacy("Fix the flaky demo test"), ...legacy("Now update the docs")];
    expect(isFirstPromptName(head(...lines), "Now update the docs")).toBe(false);
  });

  test("a line that reads as a fence in a block whose fence is not indented, which Codex keeps as the block's text", () => {
    const lines = legacy("```\nnpm run build\n``` fails on CI");
    expect(isFirstPromptName(head(...lines), "npm run build")).toBe(false);
    expect(isFirstPromptName(head(...lines), "npm run build ``` fails on CI")).toBe(true);
  });

  test("a tag after a block quote's marker in a paragraph, which the next lines continue, so their text counts", () => {
    const lines = paginated("> Fix the demo\n> <Button />\n<Card>\n  note\n</Card>");
    expect(isFirstPromptName(head(...lines), "Fix the demo")).toBe(false);
    expect(isFirstPromptName(head(...lines), "Fix the demo note")).toBe(true);
  });

  test("a first prompt of a fence alone, from which Codex makes no title, is still the one compared", () => {
    const lines = [...legacy("```"), ...legacy("Fix it")];
    expect(isFirstPromptName(head(...lines), "Fix it")).toBe(false);
  });
});

describe("a name made from text Codex takes out or changes in a way not followed here is kept", () => {
  test("an entity that is not decoded here", () => {
    const lines = legacy("Fix the &hearts; icon in the demo");
    expect(isFirstPromptName(head(...lines), "Fix the ♥ icon in the demo")).toBe(false);
  });

  test("a line of one tag that would break into a paragraph, which is no HTML block, so its text counts", () => {
    const lines = legacy("Fix the demo\n<Button>\n  save\n</Button>");
    expect(isFirstPromptName(head(...lines), "Fix the demo save")).toBe(true);
    expect(isFirstPromptName(head(...lines), "Fix the demo")).toBe(false);
  });

  test("a reference to a label the prompt does not define, which Codex keeps as written", () => {
    const lines = paginated("[the guide][g] for the demo");
    expect(isFirstPromptName(head(...lines), "[the guide][g] for the demo")).toBe(true);
    expect(isFirstPromptName(head(...lines), "the guide for the demo")).toBe(false);
  });

  test("an HTML block in a block quote, past its first line, in a name not cut with …", () => {
    const lines = paginated("> <div>\n> note\n> </div>\n\nFix the demo");
    expect(isFirstPromptName(head(...lines), "Fix the demo")).toBe(false);
  });

  test("a name cut with … before anything of the prompt that is compared", () => {
    const prompt =
      "4521 4522 4523 4524 4525 4526 4527 4528 4529 4530 4531 4532 4533 4534 then fix the demo docs";
    expect(
      isFirstPromptName(
        head(...legacy(prompt)),
        "4521 4522 4523 4524 4525 4526 4527 4528 4529 4530 4531 4532…",
      ),
    ).toBe(false);
  });
});

describe("with no prompt in reach, there is no verdict", () => {
  test("no prompt line in the bytes read", () => {
    expect(isFirstPromptName(head(), "Fix the flaky demo test")).toBeNull();
  });

  test("the response_item copy alone is never compared", () => {
    expect(
      isFirstPromptName(
        head(messageLine(START, "Fix the flaky demo test")),
        "Fix the flaky demo test",
      ),
    ).toBeNull();
  });

  test("a prompt line cut off where the bytes read end", () => {
    const whole = head(...legacy("Fix the flaky demo test"));
    expect(
      isFirstPromptName(whole.subarray(0, whole.byteLength - 1), "Fix the flaky demo test"),
    ).toBeNull();
    expect(isFirstPromptName(whole.subarray(0, whole.byteLength - 10), "Fix the flaky")).toBeNull();
  });

  test("a prompt line written inside another line, escaped, is never taken for one", () => {
    const inside = messageLine(START, `${userMessageLine(START, "Fix the flaky demo test")}\n`);
    expect(isFirstPromptName(head(inside), "Fix the flaky demo test")).toBeNull();
  });

  test("a line that begins as a prompt line but is not one, or not whole JSON", () => {
    const name = "Fix the flaky demo test";
    const broken = `${userMessageLine(START, name).slice(0, -1)},}`;
    const reply = userItemLine(START, name).replace('"UserMessage"', '"AgentMessage"');
    expect(isFirstPromptName(head(broken), name)).toBeNull();
    expect(isFirstPromptName(head(reply), name)).toBeNull();
  });

  test("a line not laid out as Codex writes one, or of another kind with a prompt's start inside it", () => {
    const name = "Fix the flaky demo test";
    const reordered = JSON.stringify({
      type: "event_msg",
      timestamp: "2026-10-01T11:50:00.000Z",
      payload: { type: "user_message", message: name },
    });
    const nested = JSON.stringify({
      timestamp: "2026-10-01T11:50:00.000Z",
      x: { a: 1, type: "event_msg", payload: { type: "user_message" } },
      type: "response_item",
      payload: { type: "user_message", message: name },
    });
    expect(isFirstPromptName(head(reordered), name)).toBeNull();
    expect(isFirstPromptName(head(nested), name)).toBeNull();
  });
});
