using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;
using ACadSharp.Entities;
using ACadSharp.IO;
using ACadSharp.Pdf;

// Development-only comparison. Never writes to the source DWG.
if (args.Length != 2)
{
    Console.Error.WriteLine("Usage: ConversionProbe input.dwg new-output-directory");
    return 2;
}
var input = Path.GetFullPath(args[0]);
var output = Path.GetFullPath(args[1]);
if (!File.Exists(input) || !input.EndsWith(".dwg", StringComparison.OrdinalIgnoreCase)
    || Directory.Exists(output) || File.Exists(output))
{
    Console.Error.WriteLine("Input must be a DWG file; output must not exist.");
    return 2;
}
using var source = new FileStream(input, FileMode.Open, FileAccess.Read, FileShare.Read);
var before = Convert.ToHexString(SHA256.HashData(source));
source.Position = 0;
// DwgReader owns/closes its input stream. Keep the original read lock separately.
using var readerInput = new MemoryStream();
source.CopyTo(readerInput);
readerInput.Position = 0;
Directory.CreateDirectory(output);
var notifications = new List<object>();
var phases = new List<object>();
var phase = "read";
NotificationEventHandler notification = (_, e) => notifications.Add(new {
    phase, kind = e.NotificationType.ToString(), message = e.Message
});
var timer = Stopwatch.StartNew();
var doc = DwgReader.Read(readerInput, new DwgReaderConfiguration {
    KeepUnknownEntities = true, Failsafe = false
}, notification);
phases.Add(new { phase, ok = true, elapsedMs = timer.ElapsedMilliseconds });
var unknown = doc.BlockRecords.SelectMany(b => b.Entities.OfType<UnknownEntity>()
    .Select(e => new { type = e.ObjectName, handle = e.Handle.ToString("X"), block = b.Name })).ToList();
bool Run(string name, Action action)
{
    phase = name;
    timer.Restart();
    try {
        action();
        phases.Add(new { phase, ok = true, elapsedMs = timer.ElapsedMilliseconds });
        return true;
    } catch (Exception e) {
        phases.Add(new { phase, ok = false, elapsedMs = timer.ElapsedMilliseconds,
            error = e.GetType().Name, message = e.Message, detail = e.ToString() });
        return false;
    }
}
var dxfOk = Run("dxf", () => {
    using var target = new FileStream(Path.Combine(output, "drawing.dxf"), FileMode.CreateNew, FileAccess.Write);
    DxfWriter.Write(target, doc, false, null, notification);
});
var pdfOk = Run("pdf", () => {
    using var target = new FileStream(Path.Combine(output, "direct.pdf"), FileMode.CreateNew, FileAccess.Write);
    var exporter = new PdfExporter(target);
    exporter.Configuration.OnNotification += notification;
    exporter.AddModelSpace(doc);
    exporter.Close();
});
source.Position = 0;
var after = Convert.ToHexString(SHA256.HashData(source));
var report = new {
    sourceUnchanged = before == after, sourceBytes = source.Length, sourceSha256 = after,
    readerAssembly = typeof(DwgReader).Assembly.GetName().Version?.ToString(),
    pdfAssembly = typeof(PdfExporter).Assembly.GetName().Version?.ToString(),
    entityCount = doc.Entities.Count,
    entities = doc.Entities.GroupBy(e => e.GetType().Name).ToDictionary(g => g.Key, g => g.Count()),
    blockEntities = doc.BlockRecords.SelectMany(b => b.Entities).GroupBy(e => e.GetType().Name)
        .ToDictionary(g => g.Key, g => g.Count()),
    unknownEntities = unknown, phases, notifications
};
File.WriteAllText(Path.Combine(output, "reader-report.json"), JsonSerializer.Serialize(report,
    new JsonSerializerOptions { WriteIndented = true }));
Console.WriteLine(JsonSerializer.Serialize(new { dxfOk, pdfOk, unknownCount = unknown.Count,
    sourceUnchanged = before == after }));
return dxfOk && pdfOk && before == after ? 0 : 1;
