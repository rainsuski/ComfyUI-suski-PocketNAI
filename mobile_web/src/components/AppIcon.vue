<script>
import { h } from "vue";

// 统一的线性图标集：24×24 视张、1.7 描边、圆角端点。
// 全部用矢量路径重绘，避免不同平台 emoji 字体带来的廉价感与尺寸漂移。
const ICONS = {
  menu: [["path", { d: "M4 7h16M4 12h16M4 17h10" }]],
  close: [["path", { d: "m6 6 12 12M18 6 6 18" }]],
  chevronDown: [["path", { d: "m7 10 5 5 5-5" }]],
  plus: [["path", { d: "M12 5v14M5 12h14" }]],
  minus: [["path", { d: "M5 12h14" }]],
  stop: [["rect", { x: 6.5, y: 6.5, width: 11, height: 11, rx: 2.6, fill: "currentColor", stroke: "none" }]],
  sparkle: [
    ["path", { d: "M12 3.6l1.9 5.2 5.2 1.9-5.2 1.9L12 17.8l-1.9-5.2L4.9 10.7l5.2-1.9z", fill: "currentColor", stroke: "none" }],
  ],
  dice: [
    ["rect", { x: 4.5, y: 4.5, width: 15, height: 15, rx: 3.4 }],
    ["circle", { cx: 9, cy: 9, r: 1.15, fill: "currentColor", stroke: "none" }],
    ["circle", { cx: 12, cy: 12, r: 1.15, fill: "currentColor", stroke: "none" }],
    ["circle", { cx: 15, cy: 15, r: 1.15, fill: "currentColor", stroke: "none" }],
  ],
  trash: [["path", { d: "M5 7h14M10 7V5.2h4V7M7.2 7l.9 12h7.8l.9-12M10.6 10.4v6M13.4 10.4v6" }]],
  power: [
    ["path", { d: "M12 4.6v7.2" }],
    ["path", { d: "M8.2 6.8a6.2 6.2 0 1 0 7.6 0" }],
  ],
  bolt: [["path", { d: "M13.3 3 6.2 13.4h4.9L10.7 21l7.1-10.4h-4.9z" }]],
  tiles: [
    ["rect", { x: 4.4, y: 4.4, width: 6.2, height: 6.2, rx: 1.6 }],
    ["rect", { x: 13.4, y: 4.4, width: 6.2, height: 6.2, rx: 1.6 }],
    ["rect", { x: 4.4, y: 13.4, width: 6.2, height: 6.2, rx: 1.6 }],
    ["rect", { x: 13.4, y: 13.4, width: 6.2, height: 6.2, rx: 1.6 }],
  ],
  diamond: [["path", { d: "M12 4.2 19 12l-7 7.8L5 12z" }]],
  tag: [
    ["path", { d: "M4.6 11.9V5.6a1 1 0 0 1 1-1h6.3l7.3 7.3-7.3 7.3-7.3-7.3z" }],
    ["circle", { cx: 8.6, cy: 8.6, r: 1.3 }],
  ],
  book: [
    ["path", { d: "M5 5.4A1.4 1.4 0 0 1 6.4 4H11v16H6.4A1.4 1.4 0 0 1 5 18.6z" }],
    ["path", { d: "M19 5.4A1.4 1.4 0 0 0 17.6 4H13v16h4.6A1.4 1.4 0 0 0 19 18.6z" }],
  ],
  copy: [
    ["rect", { x: 9.4, y: 9.4, width: 9.2, height: 9.2, rx: 2 }],
    ["path", { d: "M14.6 5.4H6.6A1.2 1.2 0 0 0 5.4 6.6v8" }],
  ],
  clear: [
    ["path", { d: "M9.2 5H20v14H9.2l-5.2-7z" }],
    ["path", { d: "m12.8 9 4.4 6M17.2 9l-4.4 6" }],
  ],
  box: [
    ["path", { d: "M12 3.6 20 8v8l-8 4.4L4 16V8z" }],
    ["path", { d: "M4 8l8 4.4L20 8M12 12.4v8" }],
  ],
  star: [
    ["path", { d: "M12 3.9l2.35 4.96 5.4.74-3.94 3.78.96 5.4L12 16.2l-4.77 2.58.96-5.4L4.25 9.6l5.4-.74z", fill: "currentColor", stroke: "none" }],
  ],
  refresh: [["path", { d: "M20 11a8 8 0 1 1-2.35-5.68M20 4v7h-7" }]],
  reset: [["path", { d: "M4 12a8 8 0 1 0 2.35-5.68M4 4v7h7" }]],
  folder: [
    ["path", { d: "M4 7h6l2 2h8v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" }],
    ["path", { d: "M4 7V6a1 1 0 0 1 1-1h4l2 2" }],
  ],
  share: [
    ["path", { d: "M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" }],
  ],
  download: [["path", { d: "M12 4v11M8 11l4 4 4-4M5 19h14" }]],
  external: [["path", { d: "M14 5h5v5M19 5l-8 8M19 14v5H5V5h5" }]],
  image: [
    ["rect", { x: 3.6, y: 5, width: 16.8, height: 14, rx: 3 }],
    ["circle", { cx: 8.8, cy: 10, r: 1.55 }],
    ["path", { d: "m4.8 16.6 4.6-4.6 3.5 3.5 2.6-2.6 3.7 3.7" }],
  ],
  shield: [
    ["path", { d: "M12 3.7 19 6.4v5.1c0 4.3-2.8 7.2-7 8.8-4.2-1.6-7-4.5-7-8.8V6.4z" }],
    ["path", { d: "m9.2 12 1.85 1.85L14.9 9.9" }],
  ],
  sun: [
    ["circle", { cx: 12, cy: 12, r: 4.1 }],
    ["path", { d: "M12 2.8v2.1M12 19.1v2.1M4.5 4.5l1.5 1.5M18 18l1.5 1.5M2.8 12h2.1M19.1 12h2.1M4.5 19.5 6 18M18 6l1.5-1.5" }],
  ],
  moon: [
    ["path", { d: "M20.1 14.3A8.4 8.4 0 0 1 9.7 3.9a8.6 8.6 0 1 0 10.4 10.4z" }],
  ],
  palette: [
    ["circle", { cx: 12, cy: 12, r: 9 }],
    ["circle", { cx: 8.5, cy: 9, r: 1.2, fill: "currentColor", stroke: "none" }],
    ["circle", { cx: 12, cy: 7.5, r: 1.2, fill: "currentColor", stroke: "none" }],
    ["circle", { cx: 15.5, cy: 9, r: 1.2, fill: "currentColor", stroke: "none" }],
    ["circle", { cx: 15, cy: 14, r: 1.2, fill: "currentColor", stroke: "none" }],
  ],
  sliders: [
    ["path", { d: "M5 7h14M5 12h14M5 17h14" }],
    ["circle", { cx: 9, cy: 7, r: 1.9 }],
    ["circle", { cx: 15, cy: 12, r: 1.9 }],
    ["circle", { cx: 10, cy: 17, r: 1.9 }],
  ],
  warning: [
    ["path", { d: "M12 4.2 20.6 19H3.4z" }],
    ["path", { d: "M12 9.6v4.2M12 16.4v.01" }],
  ],
  check: [["path", { d: "m5.6 12.4 4.2 4.2 8.6-9" }]],
  drag: [
    ["circle", { cx: 9, cy: 7, r: 1.1, fill: "currentColor", stroke: "none" }],
    ["circle", { cx: 15, cy: 7, r: 1.1, fill: "currentColor", stroke: "none" }],
    ["circle", { cx: 9, cy: 12, r: 1.1, fill: "currentColor", stroke: "none" }],
    ["circle", { cx: 15, cy: 12, r: 1.1, fill: "currentColor", stroke: "none" }],
    ["circle", { cx: 9, cy: 17, r: 1.1, fill: "currentColor", stroke: "none" }],
    ["circle", { cx: 15, cy: 17, r: 1.1, fill: "currentColor", stroke: "none" }],
  ],
};

export default {
  name: "AppIcon",
  props: {
    name: { type: String, required: true },
    size: { type: [Number, String], default: 16 },
    strokeWidth: { type: [Number, String], default: 1.7 },
  },
  setup(props) {
    return () =>
      h(
        "svg",
        {
          viewBox: "0 0 24 24",
          width: props.size,
          height: props.size,
          fill: "none",
          stroke: "currentColor",
          "stroke-width": props.strokeWidth,
          "stroke-linecap": "round",
          "stroke-linejoin": "round",
          "aria-hidden": "true",
          focusable: "false",
        },
        (ICONS[props.name] || []).map(([tag, attrs]) => h(tag, attrs)),
      );
  },
};
</script>
