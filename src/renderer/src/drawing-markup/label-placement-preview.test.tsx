import { act, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { expect, test } from "vitest";
import type { DrawingAnnotation } from "../../../shared/drawing-markup/model";
import { LabelPlacementPreview, type LabelPlacementPreviewHandle } from "./label-placement-preview";
import { DrawingAnnotationView } from "./annotation-view";

test("moving a label preview updates its own geometry and alignment guide", () => {
  const ref = createRef<LabelPlacementPreviewHandle>();
  const references = [
    {
      id: "existing",
      text: "1",
      x: 100,
      y: 50,
      fontSize: 12,
      lineWidth: 0.3,
      points: [],
    },
  ] satisfies DrawingAnnotation[];
  const { container } = render(
    <svg aria-label="标号放置测试">
      <LabelPlacementPreview
        ref={ref}
        start={{ x: 0, y: 0 }}
        end={{ x: 20, y: 20 }}
        text="2"
        fontSize={12}
        unitsPerPixel={1}
        viewWidth={1000}
        references={references}
      />
    </svg>,
  );
  act(() => ref.current?.update({ x: 103, y: 80 }));
  expect(container.querySelector('[data-drawing-preview="label"] text')?.getAttribute("x")).toBe(
    "100",
  );
  expect(container.querySelector('[data-label-align-guide="vertical"]')).not.toBeNull();
  expect(screen.queryByText("2")).not.toBeNull();
});

test("CAD fallback lettering and normalized glyphs use the same native cap height", () => {
  const props = { start: {x:0,y:0}, end: {x:20,y:20}, text:"2", fontSize:12,
    unitsPerPixel:1, viewWidth:1000, references:[], cadText:true };
  const view = render(<svg><LabelPlacementPreview {...props} /></svg>);
  const text = view.container.querySelector("text")!;
  expect(text.getAttribute("font-family")).toBe('"CAD Unified Text", serif');
  expect(Number(text.getAttribute("font-size"))).toBeCloseTo(12 / 0.729);
  view.rerender(<svg><LabelPlacementPreview {...props} glyphPaths={[{d:"M0 0L1 1Z",fill:"black",stroke:"none",width:0,point:false}]} /></svg>);
  expect(view.container.querySelector("[data-label-native-glyph]")?.getAttribute("transform"))
    .toContain("scale(12 -12)");
  view.rerender(<svg><LabelPlacementPreview {...props} fontSize={24} glyphPaths={[{d:"M0 0L1 1Z",fill:"black",stroke:"none",width:0,point:false}]} /></svg>);
  expect(view.container.querySelector("[data-label-native-glyph]")?.getAttribute("transform"))
    .toContain("scale(24 -24)");
  view.rerender(<svg><DrawingAnnotationView annotation={{id:"a",x:20,y:20,text:"2",fontSize:12,lineWidth:1,points:[]}}
    cadText selected={false} handles={false} clipped={false} color="black" viewWidth={1000} unitsPerPixel={1} canvasWidth={1000} /></svg>);
  expect(Number(view.container.querySelector("text")!.getAttribute("font-size"))).toBeCloseTo(12 / 0.729);
});
