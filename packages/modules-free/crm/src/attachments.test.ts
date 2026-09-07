import { expect, test } from "bun:test";
import { displayFilename, safeExtension } from "./attachments";

/**
 * Nothing a caller sends is used to build a path — the stored name is
 * generated. These two only decide what is displayed and what suffix the file
 * gets, but they are the functions a filename passes through, so they are
 * worth pinning against the shapes people actually send.
 */
test("a filename cannot bring a directory with it", () => {
  expect(displayFilename("../../etc/passwd")).toBe("passwd");
  expect(displayFilename("C:\\Users\\me\\quote.pdf")).toBe("quote.pdf");
  expect(displayFilename("/absolute/path/photo.jpg")).toBe("photo.jpg");
});

test("a filename with nothing usable in it still yields something", () => {
  expect(displayFilename("")).toBe("file");
  expect(displayFilename("/")).toBe("file");
});

test("an absurdly long filename is cut rather than stored whole", () => {
  expect(displayFilename(`${"a".repeat(500)}.pdf`)).toHaveLength(120);
});

test("only a plain extension is carried across", () => {
  expect(safeExtension("quote.pdf")).toBe(".pdf");
  expect(safeExtension("photo.JPEG")).toBe(".jpeg");
  // Nothing that could be read as more than a suffix.
  expect(safeExtension("payload.php.")).toBe("");
  expect(safeExtension("no-extension")).toBe("");
  expect(safeExtension("odd.name with spaces")).toBe("");
  expect(safeExtension("x.thisextensioniswaytoolong")).toBe("");
});
