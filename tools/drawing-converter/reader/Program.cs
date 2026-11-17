using System.Diagnostics;
using System.Text;
using System.Text.Json;
using ACadSharp.IO;
using ACadSharp.Entities;

try
{
    if (args.Length != 2)
        throw new ArgumentException("Usage: CadReader input.dwg new-output-directory");
    var input = Path.GetFullPath(args[0]);
    var output = Path.GetFullPath(args[1]);
    if (!string.Equals(Path.GetExtension(input), ".dwg", StringComparison.OrdinalIgnoreCase))
        throw new ArgumentException("Only DWG files are accepted.");
    if (Directory.Exists(output) || File.Exists(output))
        throw new ArgumentException("Output already exists; refusing to overwrite.");
    using var source = new FileStream(input, FileMode.Open, FileAccess.Read, FileShare.Read);
    if (source.Length < 6 || source.Length > 100 * 1024 * 1024)
        throw new ArgumentException("DWG size must be between 6 bytes and 100 MiB.");
    var header = new byte[6];
    source.ReadExactly(header);
    var version = Encoding.ASCII.GetString(header);
    if (!new[] { "AC1014", "AC1015", "AC1018", "AC1021", "AC1024", "AC1027", "AC1032" }.Contains(version))
        throw new ArgumentException("Unsupported DWG version or invalid header.");
    source.Position = 0;
    var notifications = new List<object>();
    // Diagnostics stay in the local output directory, never uploaded or committed.
    var phase = "read";
    NotificationEventHandler notification = (_, e) => notifications.Add(new { phase, kind = e.NotificationType.ToString(), message = e.Message });
    var progressClock = Stopwatch.StartNew();
    long lastProgress = -1000;
    void Progress(string stage, int? completed = null, bool force = false)
    {
        var now = progressClock.ElapsedMilliseconds;
        if (!force && now - lastProgress < 250) return;
        lastProgress = now;
        Console.Error.WriteLine("ZXW_CAD_PROGRESS " + JsonSerializer.Serialize(new { phase = stage, completed, total = (int?)null }));
    }
    Progress("read", force: true);
    int readObjects = 0;
    ACadSharp.CadDocument ReadDrawing()
    {
        // Match DwgReader.Read's lifetime: release parse buffers before DXF writing.
        using var reader = new DwgReader(source, notification);
        reader.Configuration = new DwgReaderConfiguration { KeepUnknownEntities = true, Failsafe = false };
        reader.OnProgress += (_, e) => {
            if (e.Stage == ReadStage.Read) { readObjects++; if ((readObjects & 127) == 0) Progress("read", readObjects); }
        };
        return reader.Read();
    }
    var doc = ReadDrawing();
    Progress("read", readObjects, force: true);
    var recovered = doc.BlockRecords.SelectMany(b => b.Entities.OfType<ReadOnlyDetailReference>()).ToList();
    foreach (var reference in recovered)
    {
        if (reference.Block == null || reference.Block.Entities.Count == 0)
            throw new InvalidDataException("Special detail reference has no readable target geometry.");
        var values = new[] { reference.InsertPoint.X, reference.InsertPoint.Y, reference.InsertPoint.Z,
            reference.XScale, reference.YScale, reference.ZScale, reference.Rotation,
            reference.Normal.X, reference.Normal.Y, reference.Normal.Z };
        if (values.Any(value => !double.IsFinite(value)))
            throw new InvalidDataException("Special detail reference has invalid transform data.");
    }
    Directory.CreateDirectory(output);
    phase = "convert";
    Progress("write", force: true);
    using (var target = new FileStream(Path.Combine(output, "drawing.dxf"), FileMode.CreateNew, FileAccess.Write))
        DxfWriter.Write(target, doc, false, null, notification);
    var report = new
    {
        version,
        entityCount = doc.Entities.Count,
        entities = doc.Entities.GroupBy(e => e.GetType().Name).ToDictionary(g => g.Key, g => g.Count()),
        blockEntities = doc.BlockRecords.SelectMany(b => b.Entities).GroupBy(e => e.GetType().Name).ToDictionary(g => g.Key, g => g.Count()),
        unknownEntities = doc.BlockRecords.SelectMany(b => b.Entities.OfType<ACadSharp.Entities.UnknownEntity>()
            .Select(e => new { type = e.ObjectName, handle = e.Handle.ToString("X"), block = b.Name, invisible = e.IsInvisible })),
        recoveredBlockReferences = recovered.Select(e => new { type = ReadOnlyDetailReference.SourceType,
            handle = e.Handle.ToString("X"), targetBlock = e.Block.Name, targetEntityCount = e.Block.Entities.Count,
            mode = "read-only-base-insert", needsVisualVerification = true }),
        notifications,
    };
    var json = JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true });
    File.WriteAllText(Path.Combine(output, "reader-report.json"), json);
    Console.WriteLine(JsonSerializer.Serialize(new { complete = true }));
    return 0;
}
catch (Exception error)
{
    Console.Error.WriteLine(JsonSerializer.Serialize(new { error = error.GetType().Name, message = error.Message }));
    return 1;
}
