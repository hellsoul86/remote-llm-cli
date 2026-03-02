package runtime

import "testing"

func TestRegistryAddDuplicate(t *testing.T) {
	r := NewRegistry(NewCodexAdapter())
	if err := r.Add(NewCodexAdapter()); err == nil {
		t.Fatalf("expected duplicate runtime registration error")
	}
}

func TestRegistryListSorted(t *testing.T) {
	r := NewRegistry()
	a1, err := NewTemplateAdapter(TemplateRuntimeDefinition{
		Name:    "zzz",
		Program: "zzz",
		RunArgs: []string{"{{prompt}}"},
	})
	if err != nil {
		t.Fatalf("new adapter zzz: %v", err)
	}
	a2, err := NewTemplateAdapter(TemplateRuntimeDefinition{
		Name:    "aaa",
		Program: "aaa",
		RunArgs: []string{"{{prompt}}"},
	})
	if err != nil {
		t.Fatalf("new adapter aaa: %v", err)
	}
	if err := r.Add(a1); err != nil {
		t.Fatalf("add zzz: %v", err)
	}
	if err := r.Add(a2); err != nil {
		t.Fatalf("add aaa: %v", err)
	}
	list := r.List()
	if len(list) != 2 {
		t.Fatalf("len(list)=%d want=2", len(list))
	}
	if list[0].Name != "aaa" || list[1].Name != "zzz" {
		t.Fatalf("list not sorted: %q %q", list[0].Name, list[1].Name)
	}
}
