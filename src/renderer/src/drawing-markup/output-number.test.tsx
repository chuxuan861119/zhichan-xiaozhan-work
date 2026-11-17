import { fireEvent, render } from "@testing-library/react";
import { OutputNumber } from "./output-number";

test("output formatting does not commit a rounded value on an untouched blur", () => {
  const commit = vi.fn();
  const view = render(
    <OutputNumber label="精确宽度" value={120.123456} min={10} max={165} onCommit={commit} />,
  );
  const input = view.getByLabelText("精确宽度");
  expect(input).toHaveProperty("value", "120.1");
  fireEvent.blur(input);
  expect(commit).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: "121.23456" } });
  fireEvent.blur(input);
  expect(input).toHaveProperty("value", "121.2");
  expect(commit).toHaveBeenCalledWith(121.23456);
});

test("allows intermediate empty and out-of-range input, committing only on blur", () => {
  const commit = vi.fn();
  const view = render(
    <OutputNumber label="宽度" value={120} min={10} max={165} onCommit={commit} />,
  );
  const input = view.getByLabelText("宽度");
  fireEvent.change(input, { target: { value: "" } });
  fireEvent.change(input, { target: { value: "9" } });
  expect((input as HTMLInputElement).value).toBe("9");
  expect(commit).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: "90" } });
  fireEvent.blur(input);
  expect(commit).toHaveBeenCalledWith(90);
  fireEvent.change(input, { target: { value: "999" } });
  fireEvent.blur(input);
  expect((input as HTMLInputElement).value).toBe("120");
  expect(commit).toHaveBeenCalledTimes(1);
});
