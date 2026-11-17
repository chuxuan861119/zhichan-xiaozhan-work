import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef, useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { CadNumberInput, CadRatioInput, formatCadNumber } from "./cad-number-input";

afterEach(cleanup);

test("pointer values update only the input and hand off full precision when editing starts", () => {
  const live = createRef<{update(value:string):void}>();
  const focused = vi.fn();
  let renders = 0;
  function Parent() {
    renders++;
    return <CadNumberInput aria-label="动态比例" value="1" liveRef={live} onLiveValueFocus={focused}/>;
  }
  const {rerender} = render(<Parent/>);
  const before = renders;
  act(()=>live.current?.update("2.3456789"));
  expect(screen.getByLabelText("动态比例")).toHaveProperty("value","2.3");
  expect(renders).toBe(before);
  fireEvent.focus(screen.getByLabelText("动态比例"));
  expect(focused).toHaveBeenCalledWith("2.3456789");
  rerender(<CadNumberInput aria-label="动态比例" value="3" liveRef={live}/>);
  expect(screen.getByLabelText("动态比例")).toHaveProperty("value","3");
});
test.each([1.15, 2.55, 0.15])("decimal half values round as users expect: %s", (value) => {
  const expected = value === 1.15 ? "1.2" : value === 2.55 ? "2.6" : "0.2";
  expect(formatCadNumber(value)).toBe(expected);
});
test("detail ratio display agrees with the canvas without changing the stored factor", () => {
  const change = vi.fn();
  const { rerender } = render(
    <CadRatioInput aria-label="局部比例" value="8.292088:1" onChange={change} />,
  );
  const input = screen.getByLabelText("局部比例");
  expect(input).toHaveProperty("value", "8.3:1");
  fireEvent.blur(input);
  expect(change).not.toHaveBeenCalled();
  rerender(<CadRatioInput aria-label="局部比例" value="1:3" onChange={change} />);
  expect(input).toHaveProperty("value", "0.3:1");
  rerender(<CadRatioInput aria-label="局部比例" value="bad:1" onChange={change} />);
  expect(input).toHaveProperty("value", "bad:1");
});
test.each([
  [8.292088, "8.3"],
  [1, "1"],
  [-1.26, "-1.3"],
  [0, "0"],
  [0.01234, "1.2e-2"],
  [-0.00123, "-1.2e-3"],
] as const)("formats %s without a decimal tail or misleading zero", (value, display) => {
  expect(formatCadNumber(value)).toBe(display);
});
test("formatting never emits edits; typing stays intact until blur or Enter", () => {
  const change = vi.fn();
  function Example() {
    const [value, setValue] = useState("8.292088");
    return (
      <CadNumberInput
        aria-label="比例"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          change(e.target.value);
        }}
      />
    );
  }
  render(<Example />);
  const input = screen.getByLabelText("比例");
  expect(input).toHaveProperty("value", "8.3");
  fireEvent.focus(input);
  fireEvent.blur(input);
  expect(change).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: "" } });
  expect(input).toHaveProperty("value", "");
  fireEvent.change(input, { target: { value: "1.23456" } });
  expect(input).toHaveProperty("value", "1.23456");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input).toHaveProperty("value", "1.2");
  expect(change).toHaveBeenLastCalledWith("1.23456");
  fireEvent.change(input, { target: { value: "0.01234" } });
  fireEvent.blur(input);
  expect(input).toHaveProperty("value", "1.2e-2");
  expect(change).toHaveBeenLastCalledWith("0.01234");
});
test("counts and standard lineweights retain their own precision", () => {
  const { rerender } = render(<CadNumberInput aria-label="数值" value="0.25" decimals={2} />);
  expect(screen.getByLabelText("数值")).toHaveProperty("value", "0.25");
  rerender(<CadNumberInput aria-label="数值" value="3.25" decimals={null} />);
  expect(screen.getByLabelText("数值")).toHaveProperty("value", "3.25");
});
