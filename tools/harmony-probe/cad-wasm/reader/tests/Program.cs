using ACadSharp;
using ACadSharp.Entities;
using ACadSharp.Objects;
using ACadSharp.Tables;
using CSMath;

void Check(bool condition, string message)
{
    if (!condition) throw new Exception(message);
}
var sender = new object();
var argsForEvent = new CollectionChangedEventArgs(new Line());
var actual = new List<int>();
var expected = new List<int>();
var handlers = new HarmonyImportRemovalHandlers();
EventHandler<CollectionChangedEventArgs>? reference = null;
var actualHandlers = Enumerable.Range(0, 4).Select(i => (EventHandler<CollectionChangedEventArgs>)((s, e) => {
    Check(ReferenceEquals(s, sender) && ReferenceEquals(e, argsForEvent), "Event payload changed");
    actual.Add(i);
})).ToArray();
var expectedHandlers = Enumerable.Range(0, 4).Select(i => (EventHandler<CollectionChangedEventArgs>)((_, _) => expected.Add(i))).ToArray();
var random = new Random(7369);
for (var operation = 0; operation < 300; operation++)
{
    var indexes = Enumerable.Range(0, random.Next(1, 4)).Select(_ => random.Next(4)).ToArray();
    EventHandler<CollectionChangedEventArgs>? addActual = null, addExpected = null;
    foreach (var index in indexes) { addActual += actualHandlers[index]; addExpected += expectedHandlers[index]; }
    if (random.Next(2) == 0) { handlers.Add(addActual); reference += addExpected; }
    else { handlers.Remove(addActual); reference -= addExpected; }
    actual.Clear(); expected.Clear(); handlers.Invoke(sender, argsForEvent); reference?.Invoke(sender, argsForEvent);
    Check(actual.SequenceEqual(expected), "Ordering, duplicates, or grouped removal differs from delegates");
}
handlers.Add(null); handlers.Remove(null);

var mutation = new HarmonyImportRemovalHandlers();
var calls = new List<int>();
EventHandler<CollectionChangedEventArgs> second = (_, _) => calls.Add(2);
EventHandler<CollectionChangedEventArgs> third = (_, _) => calls.Add(3);
mutation.Add((_, _) => { calls.Add(1); mutation.Remove(second); mutation.Add(third); });
mutation.Add(second); mutation.Invoke(sender, argsForEvent);
Check(calls.SequenceEqual(new[] { 1, 2 }), "Mutation changed the current invocation snapshot");
calls.Clear(); mutation.Invoke(sender, argsForEvent);
Check(calls.SequenceEqual(new[] { 1, 3 }), "Mutation did not affect the next invocation");
var failure = new HarmonyImportRemovalHandlers(); var calledAfterFailure = false;
failure.Add((_, _) => throw new InvalidOperationException("expected"));
failure.Add((_, _) => calledAfterFailure = true);
try { failure.Invoke(sender, argsForEvent); throw new Exception("Exception swallowed"); }
catch (InvalidOperationException) { }
Check(!calledAfterFailure, "Handlers ran after an exception");

// Exercise the patched library, including dictionary cloning and entity references.
var doc = new CadDocument(); var layer = new Layer("temporary"); doc.Layers.Add(layer);
var line = new Line(new XYZ(1, 2, 0), new XYZ(3, 4, 0)) { Layer = layer };
doc.Entities.Add(line); doc.Layers.Remove(layer.Name);
Check(line.Layer.Name == "0" && line.StartPoint.X == 1 && line.EndPoint.Y == 4, "Layer removal or geometry changed");
var dictionary = new CadDictionary(); dictionary.Add(new Group { Name = "test" }); var originalCalls = 0;
dictionary.OnRemove += (_, _) => originalCalls++;
var clone = (CadDictionary)dictionary.Clone(); var cloneCalls = 0; clone.OnRemove += (_, _) => cloneCalls++;
clone.Remove("test"); Check(originalCalls == 0 && cloneCalls == 1, "Clone retained original subscriptions");
dictionary.Remove("test"); Check(originalCalls == 1 && cloneCalls == 1, "Clone altered original subscriptions");
var table = new CadDocument().Layers;
table.Add(new Layer("a")); table.Add(new Layer("b")); var tableCalls = 0; var tableCloneCalls = 0;
table.OnRemove += (_, _) => tableCalls++;
var tableClone = (ACadSharp.Tables.Collections.LayersTable)table.Clone();
tableClone.OnRemove += (_, _) => tableCloneCalls++;
tableClone.Remove("a"); Check(tableCalls == 1 && tableCloneCalls == 1, "Table clone lost existing subscriptions");
table.Remove("b"); Check(tableCalls == 2 && tableCloneCalls == 1, "Table clone shares mutable subscriptions");
var many = new HarmonyImportRemovalHandlers(); var invoked = 0;
EventHandler<CollectionChangedEventArgs> repeated = (_, _) => invoked++;
var allocation = GC.GetAllocatedBytesForCurrentThread();
for (var i = 0; i < 100000; i++) many.Add(repeated);
Check(GC.GetAllocatedBytesForCurrentThread() - allocation < 32 * 1024 * 1024, "Subscriptions allocate quadratically");
many.Invoke(sender, argsForEvent); Check(invoked == 100000, "Large subscriber list lost handlers");
Console.WriteLine("PASS: delegate semantics, mutation, exceptions, layer removal, dictionary/table clone isolation, and 100000 subscriptions");
