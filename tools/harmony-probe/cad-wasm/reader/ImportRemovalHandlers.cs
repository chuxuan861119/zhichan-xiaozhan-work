using System;
using System.Collections.Generic;

namespace ACadSharp;

// Mono's multicast Combine copies the existing invocation array on every add.
// Keep the same ordered removal-event semantics with amortized constant-time adds.
// This helper is compiled only into the isolated Harmony conversion reader.
internal sealed class HarmonyImportRemovalHandlers
{
    private readonly List<EventHandler<CollectionChangedEventArgs>> handlers = new();
    private readonly object gate = new();

    public HarmonyImportRemovalHandlers Clone()
    {
        var clone = new HarmonyImportRemovalHandlers();
        lock (gate) clone.handlers.AddRange(handlers);
        return clone;
    }

    public void Add(EventHandler<CollectionChangedEventArgs>? value)
    {
        if (value == null) return;
        var entries = value.GetInvocationList();
        lock (gate)
            foreach (var entry in entries)
                handlers.Add((EventHandler<CollectionChangedEventArgs>)entry);
    }

    public void Remove(EventHandler<CollectionChangedEventArgs>? value)
    {
        if (value == null) return;
        var entries = value.GetInvocationList();
        lock (gate)
        {
            // Delegate.Remove removes the last contiguous matching invocation list.
            for (var start = handlers.Count - entries.Length; start >= 0; start--)
            {
                var matches = true;
                for (var i = 0; i < entries.Length; i++)
                    if (!handlers[start + i].Equals(entries[i])) { matches = false; break; }
                if (!matches) continue;
                handlers.RemoveRange(start, entries.Length);
                return;
            }
        }
    }

    public void Invoke(object sender, CollectionChangedEventArgs args)
    {
        EventHandler<CollectionChangedEventArgs>[] snapshot;
        lock (gate) snapshot = handlers.ToArray();
        // As with multicast delegates, mutation affects the next invocation and an
        // exception stops the current invocation without calling subsequent entries.
        foreach (var handler in snapshot) handler(sender, args);
    }
}
