using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

// Loaded by Windows PowerShell 5.1. All pathname components stay pinned without DELETE sharing.
public sealed class ProtectedCredentialStore : IDisposable {
  [StructLayout(LayoutKind.Sequential)] struct Time { public uint Low, High; }
  [StructLayout(LayoutKind.Sequential)] struct Info { public uint Attributes; public Time Creation, Access, Write; public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
  [DllImport("advapi32.dll", SetLastError=true)] static extern uint GetSecurityInfo(SafeFileHandle handle, uint type, uint flags, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
  [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr pointer);
  readonly List<SafeFileHandle> holds = new List<SafeFileHandle>();
  readonly string directory;
  readonly SecurityIdentifier user = WindowsIdentity.GetCurrent().User;
  const uint Reparse = 0x400, Directory = 0x10;
  static SafeFileHandle Open(string path, uint access, uint flags) {
    SafeFileHandle h = CreateFile(path, access, 3, IntPtr.Zero, 3, flags | 0x00200000, IntPtr.Zero);
    if (h.IsInvalid) { int error = Marshal.GetLastWin32Error(); h.Dispose(); throw new Win32Exception(error, "Protected store open failed"); }
    return h;
  }
  static Info Inspect(SafeFileHandle h, bool directory) {
    Info info;
    if (!GetFileInformationByHandle(h, out info)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Protected store inspection failed");
    if (((info.Attributes & Directory) != 0) != directory || (info.Attributes & Reparse) != 0) throw new InvalidOperationException("Unsafe protected store object");
    return info;
  }
  void Private(SafeFileHandle h) {
    IntPtr owner, group, dacl, sacl, descriptor;
    uint error = GetSecurityInfo(h, 1, 5, out owner, out group, out dacl, out sacl, out descriptor);
    if (error != 0) throw new Win32Exception((int)error, "Protected store ACL inspection failed");
    try {
      byte[] bytes = new byte[GetSecurityDescriptorLength(descriptor)];
      Marshal.Copy(descriptor, bytes, 0, bytes.Length);
      var acl = new RawSecurityDescriptor(bytes, 0);
      if (acl.Owner != user || (acl.ControlFlags & ControlFlags.DiscretionaryAclProtected) == 0 || acl.DiscretionaryAcl == null) throw new InvalidOperationException("Unsafe protected store ACL");
      foreach (GenericAce ace in acl.DiscretionaryAcl) {
        KnownAce known = ace as KnownAce;
        if (known == null || (known.SecurityIdentifier != user && known.SecurityIdentifier.Value != "S-1-5-18")) throw new InvalidOperationException("Unsafe protected store ACL");
      }
    } finally { LocalFree(descriptor); }
  }
  public ProtectedCredentialStore(string path, bool create) {
    directory = Path.GetFullPath(path);
    string volume = Path.GetPathRoot(directory);
    if (directory.TrimEnd('\\') == volume.TrimEnd('\\')) throw new InvalidOperationException("Store cannot be volume root");
    string relative = directory.Substring(volume.Length);
    string[] parts = relative.Split(new [] {'\\'}, StringSplitOptions.RemoveEmptyEntries);
    string current = volume;
    try {
      SafeFileHandle first = Open(current, 0x80, 0x02000000); holds.Add(first); Inspect(first, true);
      for (int i = 0; i < parts.Length; i++) {
        current = Path.Combine(current, parts[i]);
        if (i == parts.Length - 1 && create && !System.IO.Directory.Exists(current) && !File.Exists(current)) {
          var acl = new DirectorySecurity();
          acl.SetAccessRuleProtection(true, false);
          acl.SetOwner(user);
          acl.AddAccessRule(new FileSystemAccessRule(user, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
          System.IO.Directory.CreateDirectory(current, acl);
        }
        SafeFileHandle hold = Open(current, 0x80 | (i == parts.Length - 1 ? 0x20000u : 0u), 0x02000000);
        holds.Add(hold); Inspect(hold, true);
      }
      Private(holds[holds.Count - 1]);
    } catch { Dispose(); throw; }
  }
  public byte[] Read(string name) {
    using (SafeFileHandle h = Open(Path.Combine(directory, name), 0x80000000 | 0x20000, 0)) {
      Info info = Inspect(h, false); Private(h);
      long length = ((long)info.SizeHigh << 32) | info.SizeLow;
      if (length > 65536) throw new InvalidOperationException("Oversized protected entry");
      using (var stream = new FileStream(h, FileAccess.Read)) {
        byte[] data = new byte[(int)length]; int offset = 0;
        while (offset < data.Length) { int n = stream.Read(data, offset, data.Length - offset); if (n == 0) throw new EndOfStreamException(); offset += n; }
        return data;
      }
    }
  }
  public void Publish(string name, byte[] blob) {
    var acl = new FileSecurity(); acl.SetAccessRuleProtection(true, false); acl.SetOwner(user);
    acl.AddAccessRule(new FileSystemAccessRule(user, FileSystemRights.FullControl, AccessControlType.Allow));
    string temp = Path.Combine(directory, Path.GetRandomFileName());
    bool created = false;
    try {
      using (var stream = new FileStream(temp, FileMode.CreateNew, FileSystemRights.Write | FileSystemRights.ReadPermissions, FileShare.None, 4096, FileOptions.None, acl)) {
        created = true; stream.Write(blob, 0, blob.Length);
      }
      using (SafeFileHandle h = Open(temp, 0x80 | 0x20000, 0)) { Inspect(h, false); Private(h); }
      File.Move(temp, Path.Combine(directory, name)); // Windows MoveFile never replaces an existing entry.
      created = false;
    } finally { if (created) File.Delete(temp); }
  }
  public void Dispose() { for (int i = holds.Count - 1; i >= 0; i--) holds[i].Dispose(); holds.Clear(); }
}
