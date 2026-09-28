import { createTheme } from "@mui/material/styles";

declare module "@mui/material/Button" {
  interface ButtonPropsVariantOverrides {
    tonal: true;
  }
}

export function makeTheme(dark: boolean) {
  return createTheme({
    palette: {
      mode: dark ? "dark" : "light",
      primary: {
        main: dark ? "#b5c4ff" : "#425da8",
        contrastText: dark ? "#142750" : "#ffffff",
      },
      secondary: { main: dark ? "#b9ccc4" : "#4f635b" },
      background: {
        default: dark ? "#111318" : "#f8f9ff",
        paper: dark ? "#1b1e26" : "#f0f2fa",
      },
      text: {
        primary: dark ? "#e3e6ef" : "#1b1c23",
        secondary: dark ? "#bcc2d2" : "#606575",
      },
      divider: dark ? "#373c49" : "#dce0ed",
    },
    shape: { borderRadius: 16 },
    typography: {
      fontFamily: '"Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
      button: { textTransform: "none", fontWeight: 600 },
      h4: { fontWeight: 600, letterSpacing: "-1.2px" },
      h5: { fontWeight: 600, letterSpacing: "-.6px" },
    },
    components: {
      MuiButton: {
        defaultProps: { disableElevation: true },
        variants: [
          {
            props: { variant: "tonal" },
            style: {
              background: dark ? "#303f65" : "#e8edfc",
              color: dark ? "#dce5ff" : "#425da8",
            },
          },
        ],
        styleOverrides: {
          root: { borderRadius: 28, minHeight: 42, paddingInline: 22 },
          sizeSmall: { minHeight: 34, paddingInline: 14 },
        },
      },
      MuiPaper: {
        defaultProps: { elevation: 0 },
        styleOverrides: { root: { backgroundImage: "none" } },
      },
      MuiDialog: { styleOverrides: { paper: { borderRadius: 28 } } },
      MuiDialogTitle: {
        styleOverrides: { root: { padding: "26px 28px 16px", fontSize: 23 } },
      },
      MuiDialogContent: {
        styleOverrides: { root: { padding: "12px 28px 24px" } },
      },
      MuiDialogActions: {
        styleOverrides: { root: { padding: "12px 24px 24px" } },
      },
      MuiTextField: {
        defaultProps: { variant: "outlined", size: "small", fullWidth: true },
      },
      MuiOutlinedInput: { styleOverrides: { root: { borderRadius: 12 } } },
      MuiChip: {
        styleOverrides: {
          root: { borderRadius: 8, fontSize: 12 },
          sizeSmall: { height: 25 },
        },
      },
      MuiTableCell: {
        styleOverrides: {
          head: {
            color: dark ? "#bcc2d2" : "#606575",
            fontSize: 12,
            fontWeight: 600,
          },
          root: { padding: "17px 20px" },
        },
      },
      MuiAlert: { styleOverrides: { root: { borderRadius: 16 } } },
      MuiTooltip: { defaultProps: { arrow: true } },
    },
  });
}
