using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;

// A restricted copy of this test process's token: the access check must also grant
// Everyone, which the private store never grants. No account or machine policy changes.
public static class DiagnosticsAccessDenial {
    [StructLayout(LayoutKind.Sequential)] struct Sid { public IntPtr Pointer; public uint Attributes; }
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool CreateRestrictedToken(IntPtr token, uint flags, uint disableCount, IntPtr disable, uint privilegeCount, IntPtr privileges, uint restrictCount, Sid[] restricted, out IntPtr result);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    public static bool CannotRead(string path) {
        byte[] sidBytes = new byte[68];
        var everyone = new SecurityIdentifier("S-1-1-0");
        everyone.GetBinaryForm(sidBytes, 0);
        IntPtr memory = Marshal.AllocHGlobal(everyone.BinaryLength), token = IntPtr.Zero;
        try {
            Marshal.Copy(sidBytes, 0, memory, everyone.BinaryLength);
            using (var current = WindowsIdentity.GetCurrent()) {
                if (!CreateRestrictedToken(current.Token, 1, 0, IntPtr.Zero, 0, IntPtr.Zero, 1, new [] { new Sid { Pointer = memory } }, out token))
                    throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            }
            using (WindowsIdentity.Impersonate(token)) {
                try { using (File.OpenRead(path)) { } return false; }
                catch (UnauthorizedAccessException) { return true; }
            }
        } finally { if (token != IntPtr.Zero) CloseHandle(token); Marshal.FreeHGlobal(memory); }
    }
}
