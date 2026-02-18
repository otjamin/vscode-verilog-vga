# VGA Simulator for Verilog in VS Code

A VS Code extension that provides an integrated VGA simulator for Verilog designs. Simulate and visualize VGA output directly in your editor.

## Usage

### Opening the Simulator

1. **Via Command Palette**: Press `Ctrl+Shift+P` (Windows/Linux) or `Cmd+Shift+P` (macOS)
2. Type "VerilogVGA: Open VGA Simulator"
3. The simulator panel opens in your editor

### Verilog Module Interface

#### Required VGA Output Signals

Your top-level Verilog module must provide the following **output ports**:

```verilog
output wire hsync;
output wire vsync;
output wire [1:0] r;
output wire [1:0] g;
output wire [1:0] b;
```

#### Optional Keyboard Input Signals

Your module can optionally accept these **input ports** for user interaction:

```verilog
input wire key_0, key_1, key_2, key_3, key_4;
input wire key_5, key_6, key_7, key_8, key_9;
input wire key_up, key_down, key_left, key_right;
input wire key_space;
```

Press keys in the simulator to drive corresponding input signals high.

#### Example Module Header

```verilog
module vga_display (
  input wire clk,
  input wire rst_n,
  input wire key_space,
  output wire hsync, vsync,
  output wire [1:0] r, g, b
);
  // Your implementation
endmodule
```

